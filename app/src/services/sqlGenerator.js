function generateSqlFromQuestion(question, schemaObjects, maxRows, dialect = "postgres") {
  const normalizedQuestion = String(question || "").toLowerCase();
  const limit = Number.isFinite(Number(maxRows)) ? Number(maxRows) : 1000;

  if (!Array.isArray(schemaObjects) || schemaObjects.length === 0) {
    throw new Error("No schema objects available for selected data source. Run introspection first.");
  }

  const selectedObject = pickObjectFromQuestion(normalizedQuestion, schemaObjects) || schemaObjects[0];
  const qualifiedTable = `${quoteIdentifier(selectedObject.schema_name, dialect)}.${quoteIdentifier(selectedObject.object_name, dialect)}`;

  if (isCountQuestion(normalizedQuestion)) {
    return `SELECT COUNT(*) AS total_count FROM ${qualifiedTable};`;
  }

  if (dialect === "mssql") {
    return `SELECT TOP ${limit} * FROM ${qualifiedTable};`;
  }
  return `SELECT * FROM ${qualifiedTable} LIMIT ${limit};`;
}

function isCountQuestion(question) {
  return (
    question.includes("count") ||
    question.includes("how many") ||
    question.includes("number of")
  );
}

function pickObjectFromQuestion(question, schemaObjects) {
  return schemaObjects.find((obj) => {
    const fullName = `${obj.schema_name}.${obj.object_name}`.toLowerCase();
    const simpleName = String(obj.object_name).toLowerCase();
    return question.includes(fullName) || question.includes(simpleName);
  });
}

function quoteIdentifier(identifier, dialect = "postgres") {
  if (dialect === "mssql") {
    return `[${String(identifier).replace(/]/g, "]]")}]`;
  }
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

module.exports = {
  generateSqlFromQuestion
};
