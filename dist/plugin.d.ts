import { Schema } from 'mongoose';
declare module 'mongoose' {
    interface Schema {
        options?: SchemaOptions;
    }
    interface MongooseBulkWriteOptions {
        skipSearchPlugin?: boolean;
    }
    interface SchemaTypeOptions<T, EnforcedDocType = any> {
        search?: boolean | {
            unchanged?: boolean;
            weight?: number;
        };
    }
}
export declare const searchPlugin: (schema: Schema) => void;
