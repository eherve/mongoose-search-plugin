"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchPlugin = void 0;
const mongoose_update_to_pipeline_1 = require("@eherve/mongoose-update-to-pipeline");
const lodash = require("lodash");
const update_tools_1 = require("./update-tools");
const searchPlugin = function (schema, options) {
    const fields = getSchemaFields(schema);
    if (!fields.length)
        return;
    updateSchema(schema, fields);
    registerMiddleWare(schema, fields);
};
exports.searchPlugin = searchPlugin;
function registerMiddleWare(schema, fields) {
    schema.pre('save', async function (options) {
        if (options?.skipSearchPlugin)
            return;
        lodash.forEach(fields, field => {
            if (!field.unchanged)
                addInitialValue(this, field.path);
        });
    });
    schema.pre('insertMany', function (next, docs, options) {
        if (options?.skipSearchPlugin)
            return next();
        if (!Array.isArray(docs) || docs.length === 0)
            return next();
        lodash.forEach(docs, doc => lodash.forEach(fields, field => {
            if (!field.unchanged)
                addInitialValue(doc, field.path);
        }));
        return next();
    });
    schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace'], async function () {
        const options = this.getOptions();
        if (options?.skipSearchPlugin)
            return;
        const queryUpdate = this.getUpdate();
        if (!queryUpdate)
            return;
        const update = consolidateUpdate(fields, this.getFilter(), this.getUpdate(), options.arrayFilters);
        if (update)
            this.setUpdate(update);
    });
    schema.pre('bulkWrite', async function (next, operations, options) {
        if (options.skipSearchPlugin)
            return next();
        lodash.each(operations, operation => {
            let block;
            if (operation.updateOne)
                block = operation.updateOne;
            else if (operation.updateMany)
                block = operation.updateMany;
            else
                return;
            const update = consolidateUpdate(fields, block.filter, block.update, block.arrayFilters);
            if (!update)
                return;
            block.update = update;
        });
        next();
    });
    schema.pre('aggregate', async function () {
        if (this.options.skipSearchPlugin)
            return;
        const targetModel = (0, update_tools_1.getAggregateTargetModel)(this);
        if (!targetModel)
            return;
        const fields = getSchemaFields(targetModel?.schema);
        if (!fields.length)
            return;
        (0, update_tools_1.addMergeUpdateStage)(this, buildSetUpdate(fields));
    });
    schema.pre(/^find/, function (next) {
        const projection = this.projection();
        lodash.forEach(fields, field => {
            if (!projection)
                this.select(`-${field.textPath}`);
            else if (projection[field.textPath] !== true &&
                projection[field.textPath] !== 1 &&
                projection[`+${field.textPath}`] !== true &&
                projection[`+${field.textPath}`] !== 1) {
                projection[field.textPath] = false;
            }
        });
        next();
    });
}
function consolidateUpdate(fields, filter, update, arrayFilters) {
    const updatedFields = lodash.filter(fields, field => (0, update_tools_1.hasQueryFieldUpdate)(update, field.path));
    if (!updatedFields.length)
        return null;
    const $set = buildSetUpdate(updatedFields);
    if (Array.isArray(update)) {
        update.push({ $set });
        return update;
    }
    const transformedUpdate = (0, mongoose_update_to_pipeline_1.updateToPipeline)(filter, update, { arrayFilters, disabledWarn: true });
    transformedUpdate.push({ $set });
    return transformedUpdate;
}
function buildSetUpdate(fields) {
    const $set = {};
    lodash.each(fields, field => lodash.merge($set, buildUpdate(field)));
    return $set;
}
function buildUpdate(field) {
    if (field.arrays?.length)
        return buildArrayFieldUpdate(field);
    return buildFieldUpdate(field);
}
function buildArrayFieldUpdate(field) {
    const last = lodash.last(field.arrays);
    const arrayPath = field.path.substring(0, lodash.indexOf(field.path, last) + last.length + 1);
    const valuePath = field.path.substring(arrayPath.length + 1);
    return {
        [arrayPath]: {
            $map: {
                input: `$${arrayPath}`,
                as: 'elemt',
                in: { $mergeObjects: ['$$elemt', { [`__${valuePath}`]: buildFieldProjection(`$elemt.${valuePath}`) }] },
            },
        },
    };
}
function buildFieldUpdate(field) {
    return {
        [field.textPath]: buildFieldProjection(field.path),
    };
}
function buildFieldProjection(path) {
    const projection = { $function: { body: update_tools_1.searchFrText.toString(), args: [`$${path}`], lang: 'js' } };
    return projection;
}
function addInitialValue(doc, path) {
    const chunks = lodash.split(path, '.');
    const head = lodash.head(chunks);
    if (chunks.length === 1) {
        doc[`__${head}`] = (0, update_tools_1.searchFrText)(doc[head]);
    }
    else if (Array.isArray(doc[head])) {
        lodash.forEach(doc[head], d => addInitialValue(d, lodash.join(lodash.slice(chunks, 1), '.')));
    }
    else if (typeof doc[head] === 'object') {
        addInitialValue(doc[head], lodash.join(lodash.slice(chunks, 1), '.'));
    }
}
function getSchemaFields(schema, parentPath, arrays) {
    const fields = [];
    lodash.each(lodash.keys(schema.paths), key => {
        const schemaType = schema.path(key);
        const path = parentPath ? `${parentPath}.${schemaType.path}` : schemaType.path;
        switch (schemaType.instance) {
            case 'Embedded':
                fields.push(...getSchemaFields(schemaType.schema, path, arrays));
                break;
            case 'Array':
                if (schemaType.schema) {
                    fields.push(...getSchemaFields(schemaType.schema, path, lodash.concat(arrays || [], [key])));
                }
                break;
            default:
                if (schemaType.options?.search)
                    fields.push(buildField(schemaType, key, path, arrays));
        }
    });
    return fields;
}
function buildField(schemaType, name, path, arrays) {
    const prefix = lodash.join(lodash.slice(lodash.split(path, '.'), 0, -1));
    const suffix = lodash.join(lodash.slice(lodash.split(path, '.'), -1));
    const textPath = prefix ? `${prefix}.__${suffix}` : `__${suffix}`;
    const field = {
        path,
        textPath,
        name,
        unchanged: schemaType.options.search.unchanged === true,
        weight: schemaType.options.search.weight ?? 1,
    };
    if (arrays?.length)
        field.arrays = arrays;
    return field;
}
function updateSchema(schema, fields) {
    const text = {};
    lodash.each(fields, field => {
        if (!field.unchanged && !schema.path(field.textPath)) {
            const schemaPath = field.path.substring(0, lodash.lastIndexOf(field.path, '.'));
            const info = schema.path(schemaPath);
            if (info?.schema)
                info.schema.path(field.textPath.substring(schemaPath.length + 1), { type: String });
            else
                schema.path(field.textPath, { type: String, select: false });
            text[field.path] = field.weight;
            text[field.textPath] = field.weight;
        }
    });
    schema.index(lodash.reduce(lodash.keys(text), (pv, cv) => ((pv[cv] = 'text'), pv), {}), { weights: text, name: 'TextIndex' });
}
