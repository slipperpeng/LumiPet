'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    bottomRightBounds,
    draggedWindowBounds,
    isFinitePosition,
    scaledWindowSize
} = require('../src/window-utils');

test('positions the pet inside the bottom-right work area', () => {
    const result = bottomRightBounds(
        { x: 0, y: 25, width: 1512, height: 957 },
        360,
        520,
        18
    );

    assert.deepEqual(result, {
        x: 1134,
        y: 444,
        width: 360,
        height: 520
    });
});

test('accounts for displays with a non-zero origin', () => {
    const result = bottomRightBounds(
        { x: -1920, y: 0, width: 1920, height: 1080 },
        280,
        400,
        18
    );

    assert.equal(result.x, -298);
    assert.equal(result.y, 662);
});

test('rejects non-finite drag positions', () => {
    assert.equal(isFinitePosition(10, -20), true);
    assert.equal(isFinitePosition(Number.NaN, 0), false);
    assert.equal(isFinitePosition(0, Number.POSITIVE_INFINITY), false);
});

test('moves a dragged window without changing its size', () => {
    const result = draggedWindowBounds(
        { x: 320, y: 240, width: 999, height: 999 },
        { x: 500, y: 400 },
        { x: 615, y: 455 },
        360,
        520
    );

    assert.deepEqual(result, {
        x: 435,
        y: 295,
        width: 360,
        height: 520
    });
});

test('scales both window dimensions from a percentage', () => {
    assert.deepEqual(scaledWindowSize(360, 520, 50), { width: 180, height: 260 });
    assert.deepEqual(scaledWindowSize(360, 520, 125), { width: 450, height: 650 });
    assert.deepEqual(scaledWindowSize(360, 520, 150), { width: 540, height: 780 });
});
