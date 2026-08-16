'use strict';

function bottomRightBounds(workArea, width, height, margin = 18) {
    return {
        x: Math.round(workArea.x + workArea.width - width - margin),
        y: Math.round(workArea.y + workArea.height - height - margin),
        width,
        height
    };
}

function isFinitePosition(x, y) {
    return Number.isFinite(x) && Number.isFinite(y);
}

function draggedWindowBounds(startBounds, startCursor, cursor, width, height) {
    return {
        x: Math.round(startBounds.x + cursor.x - startCursor.x),
        y: Math.round(startBounds.y + cursor.y - startCursor.y),
        width,
        height
    };
}

function scaledWindowSize(baseWidth, baseHeight, scalePercent) {
    const ratio = scalePercent / 100;
    return {
        width: Math.round(baseWidth * ratio),
        height: Math.round(baseHeight * ratio)
    };
}

module.exports = {
    bottomRightBounds,
    draggedWindowBounds,
    isFinitePosition,
    scaledWindowSize
};
