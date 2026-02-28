/**
 * Read a .sql file handling UTF-16 LE/BE encoding (common in SSMS exports).
 * Falls back to UTF-8 for standard files.
 */
export async function readSqlFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let encoding = 'utf-8';
    if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
            encoding = 'utf-16le';
        } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
            encoding = 'utf-16be';
        }
    }

    const decoder = new TextDecoder(encoding);
    return decoder.decode(buffer);
}
