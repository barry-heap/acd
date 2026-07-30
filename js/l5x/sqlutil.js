// Small sql.js query helpers used throughout the builders, replacing
// Python's cur.execute()/fetchall()/fetchone() cursor pattern.

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.get());
    return rows;
  } finally {
    stmt.free();
  }
}

function queryOne(db, sql, params = []) {
  const rows = queryAll(db, sql, params);
  return rows.length ? rows[0] : null;
}

module.exports = { queryAll, queryOne };
