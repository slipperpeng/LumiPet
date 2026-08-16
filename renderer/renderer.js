'use strict';

const canvas = document.getElementById('live2d-canvas');
const statusElement = document.getElementById('status');

let pixiApp = null;
let live2dModel = null;
let sourceWidth = 0;
let sourceHeight = 0;
let parameterMap = null;
let parameterLimits = new Map();
let parameterNeutralValues = new Map();
let trackingX = 0;
let trackingY = 0;
let eyeTrackingEnabled = true;
let modelLoadSequence = 0;
let pendingModelChange;

const INTERACTION_PARAMETER_IDS = [
    'ParamEyeLOpen',
    'ParamEyeROpen',
    'ParamEyeLSmile',
    'ParamEyeRSmile',
    'ParamBrowLX',
    'ParamBrowLY',
    'ParamBrowRX',
    'ParamBrowRY',
    'ParamBrowLForm',
    'ParamBrowRForm',
    'ParamMouthForm',
    'ParamMouthOpenY',
    'ParamCheek',
    'ParamAngleX',
    'ParamAngleY',
    'ParamAngleZ',
    'ParamBreath'
];

const CLICK_MOVE_THRESHOLD = 10;
const CLICK_TIME_THRESHOLD = 650;
const BLINK_MIN_DELAY = 2200;
const BLINK_MAX_DELAY = 4300;
const DEFAULT_PARAMETER_OFFSETS = Object.freeze({
    ParamMouthForm: 0.22
});

let animationClock = 0;
let nextBlinkAt = 0;
let blinkState = null;
let reactionState = null;
let dragInteraction = null;
let pointerGesture = null;

function setStatus(message) {
    statusElement.textContent = message;
    statusElement.hidden = !message;
}

function fitModel() {
    if (!live2dModel || !sourceWidth || !sourceHeight) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = Math.min(
        (width * 0.98) / sourceWidth,
        (height * 0.98) / sourceHeight
    );

    live2dModel.scale.set(scale);
    live2dModel.x = width / 2;
    live2dModel.y = height - (sourceHeight * scale) / 2 - 2;
}

function buildParameterMap() {
    try {
        const parameters = live2dModel.internalModel.coreModel._model.parameters;
        parameterMap = new Map();
        parameterLimits = new Map();
        parameterNeutralValues = new Map();
        for (let index = 0; index < parameters.count; index += 1) {
            const id = parameters.ids[index];
            const minimum = Number.isFinite(parameters.minimumValues?.[index])
                ? parameters.minimumValues[index]
                : -Infinity;
            const maximum = Number.isFinite(parameters.maximumValues?.[index])
                ? parameters.maximumValues[index]
                : Infinity;
            parameterMap.set(id, index);
            parameterLimits.set(id, { minimum, maximum });
            parameterNeutralValues.set(id, parameters.values[index]);
        }
    } catch (error) {
        console.warn('[model] Model parameters are unavailable:', error.message);
    }
}

function setParameter(id, value) {
    if (!live2dModel || !parameterMap || !Number.isFinite(value)) return;
    const index = parameterMap?.get(id);
    if (index === undefined) return;
    const limits = parameterLimits.get(id);
    const minimum = limits?.minimum ?? -Infinity;
    const maximum = limits?.maximum ?? Infinity;
    const boundedValue = Math.max(minimum, Math.min(maximum, value));
    live2dModel.internalModel.coreModel._model.parameters.values[index] = boundedValue;
}

function getNeutralParameter(id, fallback = 0) {
    const value = parameterNeutralValues.get(id);
    return Number.isFinite(value) ? value : fallback;
}

function getParameterMinimum(id, fallback = 0) {
    const value = parameterLimits.get(id)?.minimum;
    return Number.isFinite(value) ? value : fallback;
}

function getParameterMaximum(id, fallback = 1) {
    const value = parameterLimits.get(id)?.maximum;
    return Number.isFinite(value) ? value : fallback;
}

function getBaseParameter(id, fallback = 0) {
    return getNeutralParameter(id, fallback) + (DEFAULT_PARAMETER_OFFSETS[id] || 0);
}

function setRelativeParameter(id, offset) {
    setParameter(id, getBaseParameter(id) + offset);
}

function setRangeParameter(id, normalizedValue) {
    const minimum = getParameterMinimum(id);
    const maximum = getParameterMaximum(id);
    setParameter(id, minimum + (maximum - minimum) * normalizedValue);
}

function resetInteractionParameters() {
    for (const id of INTERACTION_PARAMETER_IDS) {
        if (parameterNeutralValues.has(id)) setParameter(id, getBaseParameter(id));
    }
}

function applyCursorTracking() {
    if (!live2dModel || !parameterMap || !eyeTrackingEnabled) return;
    setParameter('ParamEyeBallX', trackingX);
    setParameter('ParamEyeBallY', -trackingY);
}

function setEyeTrackingEnabled(enabled) {
    eyeTrackingEnabled = Boolean(enabled);
    if (eyeTrackingEnabled) return;

    trackingX = 0;
    trackingY = 0;
    setParameter('ParamEyeBallX', 0);
    setParameter('ParamEyeBallY', 0);
}

async function updateCursorTracking() {
    if (!eyeTrackingEnabled) return;
    try {
        const [cursor, bounds] = await Promise.all([
            window.petAPI.getCursorPosition(),
            window.petAPI.getWindowBounds()
        ]);
        if (!cursor || !bounds) return;

        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        trackingX = Math.max(-1, Math.min(1, (cursor.x - centerX) / 320));
        trackingY = Math.max(-1, Math.min(1, (cursor.y - centerY) / 320));
    } catch {
        // Cursor tracking is decorative; rendering continues if it is unavailable.
    }
}

function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, value));
}

function easeInOut(value) {
    const progress = clamp(value);
    return progress * progress * (3 - 2 * progress);
}

function randomBetween(minimum, maximum) {
    return minimum + Math.random() * (maximum - minimum);
}

function scheduleNextBlink(minimum = BLINK_MIN_DELAY, maximum = BLINK_MAX_DELAY) {
    nextBlinkAt = animationClock + randomBetween(minimum, maximum);
}

function startBlink(wink = false) {
    blinkState = {
        elapsed: 0,
        duration: wink ? 360 : 260,
        wink,
        side: Math.random() < 0.5 ? 'left' : 'right'
    };
}

function updateBlink(deltaMs) {
    if (!blinkState) {
        if (!dragInteraction && animationClock >= nextBlinkAt) startBlink();
        return;
    }

    blinkState.elapsed += deltaMs;
    const progress = clamp(blinkState.elapsed / blinkState.duration);
    const closeAmount = progress < 0.38
        ? easeInOut(progress / 0.38)
        : 1 - easeInOut((progress - 0.38) / 0.62);
    const leftAmount = blinkState.wink && blinkState.side === 'right' ? 0 : closeAmount;
    const rightAmount = blinkState.wink && blinkState.side === 'left' ? 0 : closeAmount;
    const leftOpen = getNeutralParameter('ParamEyeLOpen', 1);
    const rightOpen = getNeutralParameter('ParamEyeROpen', 1);
    const leftClosed = getParameterMinimum('ParamEyeLOpen', 0);
    const rightClosed = getParameterMinimum('ParamEyeROpen', 0);

    setParameter('ParamEyeLOpen', leftOpen + (leftClosed - leftOpen) * leftAmount);
    setParameter('ParamEyeROpen', rightOpen + (rightClosed - rightOpen) * rightAmount);

    if (progress >= 1) {
        blinkState = null;
        scheduleNextBlink();
    }
}

function startReaction(type, direction = 1) {
    const durations = {
        happy: 900,
        shy: 1000,
        surprised: 760,
        release: 520
    };
    reactionState = {
        type,
        direction,
        elapsed: 0,
        duration: durations[type] || 800
    };
}

function applyReaction(deltaMs) {
    if (!reactionState) return;

    reactionState.elapsed += deltaMs;
    const progress = reactionState.elapsed / reactionState.duration;
    if (progress >= 1) {
        reactionState = null;
        return;
    }

    const normalized = clamp(progress);
    const strength = Math.sin(Math.PI * normalized);
    const direction = reactionState.direction;

    if (reactionState.type === 'happy') {
        setRelativeParameter('ParamMouthForm', 0.58 * strength);
        setRelativeParameter('ParamMouthOpenY', 0.14 * strength);
        setRelativeParameter('ParamCheek', 0.7 * strength);
        setRelativeParameter('ParamEyeLSmile', 0.65 * strength);
        setRelativeParameter('ParamEyeRSmile', 0.65 * strength);
        setRelativeParameter('ParamBrowLY', 0.2 * strength);
        setRelativeParameter('ParamBrowRY', 0.2 * strength);
        setRelativeParameter('ParamAngleZ', direction * 2.2 * strength);
    } else if (reactionState.type === 'shy') {
        setRelativeParameter('ParamMouthForm', 0.35 * strength);
        setRelativeParameter('ParamCheek', 0.9 * strength);
        setRelativeParameter('ParamEyeLSmile', 0.42 * strength);
        setRelativeParameter('ParamEyeRSmile', 0.42 * strength);
        setRelativeParameter('ParamBrowLY', -0.18 * strength);
        setRelativeParameter('ParamBrowRY', -0.18 * strength);
        setRelativeParameter('ParamAngleX', direction * 1.5 * strength);
        setRelativeParameter('ParamAngleZ', direction * 3 * strength);
    } else if (reactionState.type === 'surprised') {
        setRelativeParameter('ParamMouthForm', -0.35 * strength);
        setRelativeParameter('ParamMouthOpenY', 0.72 * strength);
        setRelativeParameter('ParamBrowLY', 0.55 * strength);
        setRelativeParameter('ParamBrowRY', 0.55 * strength);
        setRelativeParameter('ParamEyeLOpen', 0.12 * strength);
        setRelativeParameter('ParamEyeROpen', 0.12 * strength);
        setRelativeParameter('ParamAngleY', -direction * 2.5 * strength);
    } else if (reactionState.type === 'release') {
        const bounce = Math.sin(normalized * Math.PI * 3.2) * (1 - normalized);
        setRelativeParameter('ParamAngleZ', direction * 4.2 * bounce);
        setRelativeParameter('ParamAngleY', -direction * 1.5 * bounce);
        setRelativeParameter('ParamMouthOpenY', 0.1 * Math.abs(bounce));
    }
}

function startDragInteraction() {
    dragInteraction = {
        startedAt: animationClock,
        direction: Math.random() < 0.5 ? -1 : 1
    };
    reactionState = null;
    blinkState = null;
    scheduleNextBlink(2600, 5000);
}

function stopDragInteraction(moved) {
    const direction = dragInteraction?.direction || 1;
    dragInteraction = null;
    if (moved) startReaction('release', direction);
}

function applyDragInteraction() {
    if (!dragInteraction) return;
    const progress = easeInOut((animationClock - dragInteraction.startedAt) / 160);
    const direction = dragInteraction.direction;
    setRelativeParameter('ParamAngleZ', direction * 3.5 * progress);
    setRelativeParameter('ParamAngleY', -direction * 1.2 * progress);
    setRelativeParameter('ParamMouthOpenY', 0.08 * progress);
    setRelativeParameter('ParamEyeLOpen', -0.1 * progress);
    setRelativeParameter('ParamEyeROpen', -0.1 * progress);
}

function applyIdleMotion() {
    const breathPhase = animationClock / 2400 * Math.PI * 2;
    const swayPhase = animationClock / 3600 * Math.PI * 2;
    setRangeParameter('ParamBreath', 0.5 + 0.2 * Math.sin(breathPhase));
    setRelativeParameter('ParamAngleZ', 0.55 * Math.sin(swayPhase));
    setRelativeParameter('ParamAngleY', 0.3 * Math.sin(swayPhase * 0.7 + 0.8));
}

function updateInteractionAnimations(ticker) {
    if (!parameterMap) return;
    const rawDelta = Number(ticker?.deltaMS);
    const deltaMs = clamp(Number.isFinite(rawDelta) && rawDelta > 0 ? rawDelta : 16.67, 1, 100);
    animationClock += deltaMs;

    resetInteractionParameters();
    applyIdleMotion();
    if (dragInteraction) applyDragInteraction();
    else applyReaction(deltaMs);
    updateBlink(deltaMs);
}

function getClickRegion(event) {
    if (!live2dModel || typeof live2dModel.getBounds !== 'function') return null;
    const bounds = live2dModel.getBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    if (
        event.clientX < bounds.x ||
        event.clientX > bounds.x + bounds.width ||
        event.clientY < bounds.y ||
        event.clientY > bounds.y + bounds.height
    ) return null;

    const relativeY = (event.clientY - bounds.y) / bounds.height;
    return relativeY < 0.43 ? 'head' : 'body';
}

function triggerClickReaction(region) {
    if (region === 'head') {
        const direction = Math.random() < 0.5 ? -1 : 1;
        startReaction(Math.random() < 0.22 ? 'shy' : 'happy', direction);
        startBlink(true);
    } else if (region === 'body') {
        startReaction('surprised', Math.random() < 0.5 ? -1 : 1);
    }
}

function destroyLoadedModel() {
    if (live2dModel) {
        try {
            if (live2dModel.parent) live2dModel.parent.removeChild(live2dModel);
            live2dModel.destroy({ children: true });
        } catch (error) {
            console.warn('[Live2D] Failed to release the previous model:', error.message);
        }
    }
    live2dModel = null;
    sourceWidth = 0;
    sourceHeight = 0;
    parameterMap = null;
    parameterLimits = new Map();
    parameterNeutralValues = new Map();
    blinkState = null;
    reactionState = null;
    dragInteraction = null;
}

async function loadLive2DModel(modelInfo) {
    const sequence = ++modelLoadSequence;
    destroyLoadedModel();

    if (!modelInfo?.url) {
        setStatus('请右键选择 Live2D 模型文件夹');
        return false;
    }

    const modelLabel = modelInfo.name || modelInfo.relativePath || '模型';
    setStatus(`正在载入 ${modelLabel}...`);

    try {
        const model = await PIXI.live2d.Live2DModel.from(modelInfo.url, {
            autoUpdate: true,
            autoInteract: false
        });

        if (sequence !== modelLoadSequence) {
            model.destroy({ children: true });
            return false;
        }

        live2dModel = model;
        live2dModel.anchor.set(0.5, 0.5);
        live2dModel.scale.set(1);
        sourceWidth = live2dModel.width;
        sourceHeight = live2dModel.height;
        pixiApp.stage.addChild(live2dModel);

        fitModel();
        buildParameterMap();
        scheduleNextBlink(1200, 2600);
        setEyeTrackingEnabled(eyeTrackingEnabled);
        setStatus('');
        await new Promise((resolve) => {
            window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
        });
        if (sequence === modelLoadSequence) window.petAPI.reportReady();
        return true;
    } catch (error) {
        if (sequence !== modelLoadSequence) return false;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Live2D] Failed to load:', message);
        window.petAPI.reportError(message);
        setStatus(`角色载入失败\n${message}`);
        return false;
    }
}

async function initializeLive2D() {
    try {
        window.PIXI = PIXI;
        await PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);

        const resolution = Math.min(window.devicePixelRatio || 1, 2);
        pixiApp = new PIXI.Application({
            view: canvas,
            width: window.innerWidth,
            height: window.innerHeight,
            transparent: true,
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            resolution,
            autoStart: true,
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false
        });

        const storedPreferences = await window.petAPI.getPreferences();
        setEyeTrackingEnabled(storedPreferences?.eyeTrackingEnabled !== false);
        pixiApp.ticker.add(applyCursorTracking);
        pixiApp.ticker.add(updateInteractionAnimations);
        window.setInterval(updateCursorTracking, 50);

        const modelState = await window.petAPI.getModelState();
        if (pendingModelChange !== undefined) {
            const payload = pendingModelChange;
            pendingModelChange = undefined;
            handleModelChange(payload);
        } else if (modelState?.selectedModelUrl) {
            await loadLive2DModel({
                id: modelState.selectedModel,
                name: modelState.selectedModelName,
                url: modelState.selectedModelUrl
            });
        } else {
            setStatus(modelState?.error || '请右键选择 Live2D 模型文件夹');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Live2D] Failed to initialize:', message);
        window.petAPI.reportError(message);
        setStatus(`渲染器初始化失败\n${message}`);
    }
}

function handleModelChange(payload) {
    if (!pixiApp) {
        pendingModelChange = payload;
        return;
    }
    if (payload?.model) {
        void loadLive2DModel(payload.model);
    } else {
        modelLoadSequence += 1;
        destroyLoadedModel();
        setStatus(payload?.error || '请右键选择 Live2D 模型文件夹');
    }
}

function resizeRenderer() {
    if (!pixiApp) return;
    pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
    fitModel();
}

let activePointerId = null;
let dragReady = false;
let moveFrame = null;

function pointerDistance(gesture, event) {
    if (!gesture) return Infinity;
    return Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
}

function queueWindowMove() {
    if (moveFrame !== null) return;

    moveFrame = window.requestAnimationFrame(() => {
        moveFrame = null;
        if (activePointerId !== null && dragReady) window.petAPI.dragWindowToCursor();
    });
}

canvas.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0 || activePointerId !== null) return;
    event.preventDefault();

    activePointerId = event.pointerId;
    pointerGesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAt: window.performance.now(),
        region: getClickRegion(event),
        moved: false
    };
    dragReady = false;
    document.body.classList.add('is-dragging');
    canvas.setPointerCapture(event.pointerId);

    const started = await window.petAPI.startWindowDrag();
    if (activePointerId === event.pointerId) {
        dragReady = Boolean(started);
        if (dragReady) startDragInteraction();
    } else if (started) {
        window.petAPI.endWindowDrag();
    }
});

canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId || !dragReady) return;
    if (pointerDistance(pointerGesture, event) > CLICK_MOVE_THRESHOLD) {
        pointerGesture.moved = true;
    }
    queueWindowMove();
});

function finishDrag(event) {
    if (event.pointerId !== activePointerId) return;
    const gesture = pointerGesture;
    const distance = pointerDistance(gesture, event);
    const moved = Boolean(gesture?.moved || distance > CLICK_MOVE_THRESHOLD);
    const isClick =
        event.type === 'pointerup' &&
        !moved &&
        gesture &&
        window.performance.now() - gesture.startedAt <= CLICK_TIME_THRESHOLD;
    const wasDragging = dragReady;

    activePointerId = null;
    dragReady = false;
    pointerGesture = null;
    if (moveFrame !== null) {
        window.cancelAnimationFrame(moveFrame);
        moveFrame = null;
    }
    document.body.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    window.petAPI.endWindowDrag();

    if (wasDragging) stopDragInteraction(event.type !== 'pointerup' || moved);
    if (isClick) triggerClickReaction(gesture.region);
}

canvas.addEventListener('pointerup', finishDrag);
canvas.addEventListener('pointercancel', finishDrag);

window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.petAPI.showMenu();
});

window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'q') {
        event.preventDefault();
        window.petAPI.quit();
    }
});

window.addEventListener('resize', resizeRenderer);
window.petAPI.onWindowResized(resizeRenderer);
window.petAPI.onEyeTrackingChanged(setEyeTrackingEnabled);
window.petAPI.onModelChanged(handleModelChange);

initializeLive2D();
