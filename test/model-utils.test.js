'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanModelDirectory } = require('../src/model-utils');

function createTemporaryModelRoot(t) {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'lumipet-models-'));
    const rootDirectory = path.join(container, 'models');
    fs.mkdirSync(rootDirectory);
    t.after(() => fs.rmSync(container, { recursive: true, force: true }));
    return { container, rootDirectory };
}

function createModel(rootDirectory, relativeManifestPath, options = {}) {
    const manifestPath = path.join(rootDirectory, relativeManifestPath);
    const modelDirectory = path.dirname(manifestPath);
    fs.mkdirSync(modelDirectory, { recursive: true });
    fs.writeFileSync(path.join(modelDirectory, 'model.moc3'), 'moc');
    fs.mkdirSync(path.join(modelDirectory, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(modelDirectory, 'textures', 'texture.png'), 'texture');
    fs.writeFileSync(manifestPath, JSON.stringify({
        Version: 3,
        Name: options.name,
        FileReferences: {
            Moc: 'model.moc3',
            Textures: ['textures/texture.png'],
            ...(options.references || {})
        }
    }));
}

test('recursively scans valid model manifests and returns file URLs', (t) => {
    const { rootDirectory } = createTemporaryModelRoot(t);
    createModel(rootDirectory, path.join('one', 'one.model3.json'), { name: 'One' });
    createModel(rootDirectory, path.join('two', 'two.model3.json'));

    const result = scanModelDirectory(rootDirectory);

    assert.equal(result.models.length, 2);
    assert.deepEqual(result.models.map((model) => model.id), [
        'one/one.model3.json',
        'two/two.model3.json'
    ]);
    assert.equal(result.models[0].name, 'One');
    assert.match(result.models[0].url, /^file:/);
    assert.deepEqual(result.errors, []);
});

test('rejects references that escape the selected folder', (t) => {
    const { container, rootDirectory } = createTemporaryModelRoot(t);
    createModel(rootDirectory, 'unsafe.model3.json', {
        references: { Physics: '../outside.physics3.json' }
    });
    fs.writeFileSync(path.join(container, 'outside.physics3.json'), '{}');

    const result = scanModelDirectory(rootDirectory);

    assert.equal(result.models.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /outside the selected folder/);
});

test('keeps valid models when another manifest is malformed', (t) => {
    const { rootDirectory } = createTemporaryModelRoot(t);
    createModel(rootDirectory, 'valid.model3.json');
    fs.writeFileSync(path.join(rootDirectory, 'broken.model3.json'), '{');

    const result = scanModelDirectory(rootDirectory);

    assert.equal(result.models.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].relativePath, 'broken.model3.json');
});

test('validates nested motion and expression references', (t) => {
    const { rootDirectory } = createTemporaryModelRoot(t);
    createModel(rootDirectory, 'nested.model3.json', {
        references: {
            Expressions: [{ Name: 'smile', File: 'smile.exp3.json' }],
            Motions: {
                Idle: [{ File: 'idle.motion3.json' }]
            }
        }
    });
    fs.writeFileSync(path.join(rootDirectory, 'smile.exp3.json'), '{}');
    fs.writeFileSync(path.join(rootDirectory, 'idle.motion3.json'), '{}');

    const result = scanModelDirectory(rootDirectory);

    assert.equal(result.models.length, 1);
    assert.deepEqual(result.errors, []);
});
