function buildSqlPrompt(context) {
  const dialect = String(context.dialect || "postgres").toLowerCase();
  const dialectLabel = dialect === "mssql" ? "Microsoft SQL Server (T-SQL)" : "PostgreSQL";

  const schemaLines = (context.schemaObjects || [])
    .slice(0, 40)
    .map((obj) => `- ${obj.schema_name}.${obj.object_name} (${obj.object_type})`);

  const columnLines = (context.columns || [])
    .slice(0, 120)
    .map((col) => `- ${col.schema_name}.${col.object_name}.${col.column_name} : ${col.data_type}`);

  const semanticLines = (context.semanticEntities || [])
    .slice(0, 50)
    .map((entity) => `- ${entity.business_name} -> ${entity.target_ref} (${entity.entity_type})`);

  const metricLines = (context.metricDefinitions || [])
    .slice(0, 30)
    .map((metric) => `- ${metric.business_name}: ${metric.sql_expression}`);

  const joinPolicyLines = (context.joinPolicies || [])
    .slice(0, 30)
    .map((policy) => `- ${policy.left_ref} ${policy.join_type} ${policy.right_ref} ON ${policy.on_clause}`);

  const ragLines = (context.ragDocuments || [])
    .slice(0, 16)
    .map((doc) => {
      const summary = String(doc.content || "")
        .split("\n")
        .slice(0, 6)
        .join("\n");
      return `- [${doc.doc_type}] ref=${doc.ref_id} score=${Number(doc.score || 0).toFixed(3)}\n${indent(summary, 2)}`;
    });

  return [
    "Task:",
    `Generate one ${dialectLabel} SELECT query for the user question.`,
    dialect === "mssql"
      ? `Apply TOP ${Number(context.maxRows)} if query can return multiple rows.`
      : `Apply LIMIT ${Number(context.maxRows)} if query can return multiple rows.`,
    "",
    "Rules:",
    "- Use only the schema objects listed below.",
    "- For each referenced object, use only columns listed for that exact object.",
    "- Prefer semantic mappings and metric definitions when relevant.",
    "- Never use INSERT, UPDATE, DELETE, ALTER, DROP, CREATE, TRUNCATE, GRANT, REVOKE.",
    "- Return SQL only. No markdown, no explanation.",
    "",
    `User question: ${context.question}`,
    "",
    "Schema objects:",
    schemaLines.length > 0 ? schemaLines.join("\n") : "- none",
    "",
    "Columns:",
    columnLines.length > 0 ? columnLines.join("\n") : "- none",
    "",
    "Semantic mappings:",
    semanticLines.length > 0 ? semanticLines.join("\n") : "- none",
    "",
    "Metric definitions:",
    metricLines.length > 0 ? metricLines.join("\n") : "- none",
    "",
    "Approved join policies:",
    joinPolicyLines.length > 0 ? joinPolicyLines.join("\n") : "- none",
    "",
    "Retrieved RAG context (highest relevance):",
    ragLines.length > 0 ? ragLines.join("\n") : "- none"
  ].join("\n");
}

function buildSqlSystemPrompt(dialect) {
  const normalized = String(dialect || "postgres").toLowerCase();
  if (normalized === "mssql") {
    return "Generate a single Microsoft SQL Server (T-SQL) SELECT query for reporting. Output only SQL, no explanation.";
  }
  return "Generate a single PostgreSQL SELECT query for reporting. Output only SQL, no explanation.";
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return String(text || "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

module.exports = {
  buildSqlPrompt,
  buildSqlSystemPrompt
};
