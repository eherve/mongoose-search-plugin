"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasQueryFieldUpdate = hasQueryFieldUpdate;
exports.getAggregateTargetModel = getAggregateTargetModel;
exports.getMergePipelineStage = getMergePipelineStage;
exports.addMergeUpdateStage = addMergeUpdateStage;
exports.searchFrText = searchFrText;
const lodash = require("lodash");
function hasQueryFieldUpdate(updates, path) {
    for (let update of (Array.isArray(updates) ? updates : [updates])) {
        if (hasUpdateValue(update, path))
            return true;
        if (hasUpdateValue(update.$set, path))
            return true;
        if (hasUpdateValue(update.$setOnInsert, path))
            return true;
        if (hasUpdateValue(update.$addFields, path))
            return true;
        if (hasUpdateValue(update.$inc, path))
            return true;
        if (hasUpdateValue(update.$pull, path))
            return true;
        if (hasUpdateValue(update.$push, path))
            return true;
    }
    return false;
}
function hasUpdateValue(obj, path) {
    if (!obj)
        return false;
    if (obj[path] !== undefined)
        return true;
    if (lodash.get(obj, path) !== undefined)
        return true;
    const found = lodash.find(lodash.keys(obj), key => {
        const stripKey = lodash.replace(key, /\.\$(\[[^\]]*\])?/g, '');
        if (lodash.startsWith(path, stripKey))
            return true;
        if (lodash.startsWith(stripKey, `${path}.`))
            return true;
    });
    if (found)
        return true;
    const chunks = lodash.split(path, '.');
    for (let i = chunks.length - 1; i >= 0; --i) {
        const subpath = chunks.slice(0, i).join('.');
        if (obj[subpath] !== undefined)
            return true;
    }
    return false;
}
function getAggregateTargetModel(aggregate) {
    const $merge = getMergePipelineStage(aggregate);
    if (!$merge)
        return null;
    const collectionName = typeof $merge.into === 'string' ? $merge.into : $merge.into.coll;
    const model = aggregate.model();
    const modelName = lodash.find(model.db.modelNames(), modelName => {
        return model.db.models[modelName].collection.collectionName === collectionName;
    });
    const targetModel = modelName ? model.db.models[modelName] : null;
    return targetModel;
}
function getMergePipelineStage(aggregate) {
    const pipeline = aggregate.pipeline();
    const $merge = lodash.last(pipeline).$merge;
    return $merge ?? null;
}
function addMergeUpdateStage(aggregate, $set) {
    const $merge = getMergePipelineStage(aggregate);
    if (!$merge)
        return;
    if (typeof $merge.whenMatched === 'string') {
        switch ($merge.whenMatched) {
            case 'merge':
                $merge.whenMatched = [{ $replaceRoot: { newRoot: { $mergeObjects: ['$$ROOT', '$$new'] } } }, { $set }];
                break;
            case 'replace':
                $merge.whenMatched = [{ $replaceRoot: { newRoot: '$$new' } }, { $set }];
                break;
        }
    }
    else
        $merge.whenMatched?.push({ $set });
}
function searchFrText(value) {
    if (typeof value !== 'string')
        return '';
    return value
        .toLowerCase()
        .replace(/[^\w\s-_]/g, '')
        .split(/\s+/)
        .reduce((pv, cv) => {
        for (let i = 3; i <= cv.length; i++)
            pv.push(cv.slice(0, i));
        return pv;
    }, [])
        .filter((w, i, a) => a.indexOf(w) === i)
        .join(' ');
}
