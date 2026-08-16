'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODEL_FILE_SUFFIX = '.model3.json';
const MAX_SCAN_DEPTH = 16;

function isPathInside(rootDirectory, targetPath) {
    const relativePath = path.relative(rootDirectory, targetPath);
    return relativePath === '' || (
        relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
    );
}

function assertFile(filePath, description) {
    let stats;
    try {
        stats = fs.statSync(filePath);
    } catch {
        throw new Error(`${description} was not found`);
    }
    if (!stats.isFile()) throw new Error(`${description} is not a file`);
}

function resolveModelReference(rootDirectory, manifestPath, reference) {
    if (typeof reference !== 'string' || !reference.trim()) {
        throw new Error('contains an empty resource reference');
    }

    const resourcePath = path.resolve(path.dirname(manifestPath), reference);
    if (!isPathInside(rootDirectory, resourcePath)) {
        throw new Error(`references a resource outside the selected folder: ${reference}`);
    }
    return resourcePath;
}

function addReference(references, value) {
    if (typeof value === 'string' && value.trim()) references.push(value);
}

function collectFileReferences(fileReferences) {
    const references = [];
    for (const key of ['Moc', 'Physics', 'DisplayInfo', 'Pose', 'UserData']) {
        addReference(references, fileReferences[key]);
    }

    if (Array.isArray(fileReferences.Textures)) {
        for (const texture of fileReferences.Textures) addReference(references, texture);
    }

    const collectGroupedReferences = (groups) => {
        const visit = (value) => {
            if (typeof value === 'string') {
                addReference(references, value);
                return;
            }
            if (Array.isArray(value)) {
                for (const child of value) visit(child);
                return;
            }
            if (!value || typeof value !== 'object') return;

            addReference(references, value.File);
            for (const [key, child] of Object.entries(value)) {
                if (key === 'File' || key === 'Name') continue;
                if (typeof child === 'string') addReference(references, child);
                else if (child && typeof child === 'object') visit(child);
            }
        };

        visit(groups);
    };

    collectGroupedReferences(fileReferences.Expressions);
    collectGroupedReferences(fileReferences.Motions);
    return references;
}

function validateModelFile(rootDirectory, manifestPath) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`has invalid JSON: ${error.message}`);
    }

    const fileReferences = manifest?.FileReferences;
    if (!fileReferences || typeof fileReferences !== 'object') {
        throw new Error('does not contain FileReferences');
    }
    if (typeof fileReferences.Moc !== 'string' || !fileReferences.Moc.trim()) {
        throw new Error('does not contain a model file reference');
    }
    if (!Array.isArray(fileReferences.Textures) || fileReferences.Textures.length === 0) {
        throw new Error('does not contain texture references');
    }

    const references = collectFileReferences(fileReferences);
    for (const reference of references) {
        const resourcePath = resolveModelReference(rootDirectory, manifestPath, reference);
        assertFile(resourcePath, `Resource ${reference}`);
    }

    return manifest;
}

function collectModelFiles(directoryPath, depth = 0, result = []) {
    if (depth > MAX_SCAN_DEPTH) return result;

    let entries;
    try {
        entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
        return result;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            collectModelFiles(entryPath, depth + 1, result);
        } else if (
            entry.isFile() &&
            entry.name.toLowerCase().endsWith(MODEL_FILE_SUFFIX)
        ) {
            result.push(entryPath);
        }
    }
    return result;
}

function modelName(manifestPath, manifest) {
    const declaredName = typeof manifest.Name === 'string' ? manifest.Name.trim() : '';
    if (declaredName) return declaredName;
    const fileName = path.basename(manifestPath);
    return fileName.slice(0, -MODEL_FILE_SUFFIX.length);
}

function scanModelDirectory(directoryPath) {
    const rootDirectory = path.resolve(directoryPath);
    let stats;
    try {
        stats = fs.statSync(rootDirectory);
    } catch {
        throw new Error('The selected model folder does not exist.');
    }
    if (!stats.isDirectory()) throw new Error('The selected model path is not a folder.');

    const models = [];
    const errors = [];
    for (const manifestPath of collectModelFiles(rootDirectory)) {
        try {
            const manifest = validateModelFile(rootDirectory, manifestPath);
            const relativePath = path.relative(rootDirectory, manifestPath).split(path.sep).join('/');
            models.push({
                id: relativePath,
                name: modelName(manifestPath, manifest),
                relativePath,
                filePath: manifestPath,
                url: pathToFileURL(manifestPath).href
            });
        } catch (error) {
            const relativePath = path.relative(rootDirectory, manifestPath).split(path.sep).join('/');
            errors.push({ relativePath, message: error.message });
        }
    }

    models.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { directory: rootDirectory, models, errors };
}

module.exports = {
    MODEL_FILE_SUFFIX,
    isPathInside,
    resolveModelReference,
    scanModelDirectory,
    validateModelFile
};
