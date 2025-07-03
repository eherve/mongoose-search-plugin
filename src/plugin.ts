/** @format */

import { updateToPipeline } from '@eherve/mongoose-update-to-pipeline';
import * as lodash from 'lodash';
import {
  Aggregate,
  CallbackWithoutResultAndOptionalError,
  Model,
  Query,
  Schema,
  SchemaType,
  UpdateQuery,
} from 'mongoose';
import { addMergeUpdateStage, getAggregateTargetModel, hasQueryFieldUpdate, searchFrText } from './update-tools';

declare module 'mongoose' {
  interface Schema {
    options?: SchemaOptions;
  }
  interface MongooseBulkWriteOptions {
    skipSearchPlugin?: boolean;
  }
  interface SchemaTypeOptions<T, EnforcedDocType = any> {
    search?:
      | boolean
      | {
          unchanged?: boolean;
          weight?: number;
        };
  }
}

type Field = {
  path: string;
  textPath: string;
  name: string;
  arrays?: string[];
  unchanged: boolean;
  weight: number;
};

export const searchPlugin = function (schema: Schema) {
  const fields = getSchemaFields(schema);
  if (!fields.length) return;
  updateSchema(schema, fields);
  registerMiddleWare(schema, fields);
};

function registerMiddleWare(schema: Schema, fields: Field[]) {
  schema.pre('save', async function (this: any, options?: any) {
    if (options?.skipSearchPlugin) return;
    lodash.forEach(fields, field => {
      if (!field.unchanged) addInitialValue(this, field.path);
    });
  });

  schema.pre(
    'insertMany',
    function (this: Model<any>, next: CallbackWithoutResultAndOptionalError, docs: any[], options?: any) {
      if (options?.skipSearchPlugin) return next();
      if (!Array.isArray(docs) || docs.length === 0) return next();
      lodash.forEach(docs, doc =>
        lodash.forEach(fields, field => {
          if (!field.unchanged) addInitialValue(doc, field.path);
        })
      );
      return next();
    }
  );

  schema.pre(
    ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace'],
    async function (this: Query<any, any>) {
      const options = this.getOptions();
      if (options?.skipSearchPlugin) return;
      const queryUpdate = this.getUpdate();
      if (!queryUpdate) return;
      const update = consolidateUpdate(fields, this.getFilter(), this.getUpdate(), options.arrayFilters);
      if (update) this.setUpdate(update);
    }
  );

  schema.pre(
    'bulkWrite',
    async function (this: Model<any>, next: CallbackWithoutResultAndOptionalError, operations: any[], options?: any) {
      if (options.skipSearchPlugin) return next();
      lodash.each(operations, operation => {
        let block: any;
        if (operation.updateOne) block = operation.updateOne;
        else if (operation.updateMany) block = operation.updateMany;
        else return;
        const update = consolidateUpdate(fields, block.filter, block.update, block.arrayFilters);
        if (!update) return;
        block.update = update;
      });
      next();
    }
  );

  schema.pre('aggregate', async function (this: Aggregate<any>) {
    if (this.options.skipSearchPlugin) return;
    const targetModel = getAggregateTargetModel(this);
    if (!targetModel) return;
    const fields = getSchemaFields(targetModel?.schema);
    if (!fields.length) return;
    addMergeUpdateStage(this, buildSetUpdate(fields));
  });

  schema.pre(/^find/, function (this: Query<any, any>, next: CallbackWithoutResultAndOptionalError) {
    const projection = this.projection();
    lodash.forEach(fields, field => {
      if (!projection) this.select(`-${field.textPath}`);
      else if (
        projection[field.textPath] !== true &&
        projection[field.textPath] !== 1 &&
        projection[`+${field.textPath}`] !== true &&
        projection[`+${field.textPath}`] !== 1
      ) {
        projection[field.textPath] = false;
      }
    });
    next();
  });
}

function consolidateUpdate(fields: Field[], filter: any, update: any, arrayFilters?: any[]): any[] | null {
  const updatedFields = lodash.filter(fields, field => hasQueryFieldUpdate(update, field.path));
  if (!updatedFields.length) return null;
  const $set = buildSetUpdate(updatedFields);
  if (Array.isArray(update)) {
    update.push({ $set });
    return update;
  }
  const transformedUpdate = updateToPipeline(filter, update, { arrayFilters, disabledWarn: true });
  transformedUpdate.push({ $set });
  return transformedUpdate;
}

function buildSetUpdate(fields: Field[]): any {
  const $set: any = {};
  lodash.each(fields, field => lodash.merge($set, buildUpdate(field)));
  return $set;
}

function buildUpdate(field: Field): UpdateQuery<any> {
  if (field.arrays?.length) return buildArrayFieldUpdate(field);
  return buildFieldUpdate(field);
}

function buildArrayFieldUpdate(field: Field): any {
  const last = lodash.last(field.arrays)!;
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

function buildFieldUpdate(field: Field): any {
  return {
    [field.textPath]: buildFieldProjection(field.path),
  };
}

function buildFieldProjection(path: string): any {
  const projection = { $function: { body: searchFrText.toString(), args: [`$${path}`], lang: 'js' } };
  return projection;
}

function addInitialValue(doc: any, path: string) {
  const chunks: string[] = lodash.split(path, '.');
  const head = lodash.head(chunks)!;
  if (chunks.length === 1) {
    doc[`__${head}`] = searchFrText(doc[head]);
  } else if (Array.isArray(doc[head])) {
    lodash.forEach(doc[head], d => addInitialValue(d, lodash.join(lodash.slice(chunks, 1), '.')));
  } else if (typeof doc[head] === 'object') {
    addInitialValue(doc[head], lodash.join(lodash.slice(chunks, 1), '.'));
  }
}

function getSchemaFields(schema: Schema, parentPath?: string, arrays?: string[]): Field[] {
  const fields: Field[] = [];
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
        if (schemaType.options?.search) fields.push(buildField(schemaType, key, path, arrays));
    }
  });
  return fields;
}

function buildField(schemaType: SchemaType, name: string, path: string, arrays: string[] | undefined): Field {
  const prefix = lodash.join(lodash.slice(lodash.split(path, '.'), 0, -1));
  const suffix = lodash.join(lodash.slice(lodash.split(path, '.'), -1));
  const textPath = prefix ? `${prefix}.__${suffix}` : `__${suffix}`;
  const field: Field = {
    path,
    textPath,
    name,
    unchanged: schemaType.options.search.unchanged === true,
    weight: schemaType.options.search.weight ?? 1,
  };
  if (arrays?.length) field.arrays = arrays;
  return field;
}

function updateSchema(schema: Schema<any>, fields: Field[]) {
  const text: { [key: string]: number } = {};
  lodash.each(fields, field => {
    if (!field.unchanged && !schema.path(field.textPath)) {
      const schemaPath = field.path.substring(0, lodash.lastIndexOf(field.path, '.'));
      const info = schema.path(schemaPath);
      if (info?.schema) info.schema.path(field.textPath.substring(schemaPath.length + 1), { type: String });
      else schema.path(field.textPath, { type: String, select: false });
      text[field.path] = field.weight;
      text[field.textPath] = field.weight;
    }
  });
  schema.index(
    lodash.reduce(lodash.keys(text), (pv, cv) => ((pv[cv] = 'text'), pv), {} as any),
    { weights: text, name: 'TextIndex' }
  );
}
