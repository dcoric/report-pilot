declare module "parquetjs-lite" {
  export interface ParquetFieldDefinition {
    type: string;
    optional?: boolean;
  }

  export class ParquetSchema {
    constructor(definition: Record<string, ParquetFieldDefinition>);
  }

  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }
}
