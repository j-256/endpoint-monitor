import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MIGRATIONS_PATH = path.join(PROJECT_ROOT, "migrations")

class PreparedStatement {
  constructor(database, sql, params = []) {
    this.database = database
    this.params = params
    this.sql = sql
  }

  bind(...params) {
    return new PreparedStatement(this.database, this.sql, params)
  }

  first() {
    return Promise.resolve(
      this.database.sqlite.prepare(this.sql).get(...this.params) || null,
    )
  }

  all() {
    return Promise.resolve(this.execute())
  }

  run() {
    return Promise.resolve(this.execute())
  }

  execute() {
    const statement = this.database.sqlite.prepare(this.sql)
    if (statement.columns().length > 0) {
      return {
        meta: { changes: 0, rows_written: 0 },
        results: statement.all(...this.params),
        success: true,
      }
    }
    const result = statement.run(...this.params)
    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        rows_written: Number(result.changes),
      },
      results: [],
      success: true,
    }
  }
}

class D1DatabaseFixture {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:")
    this.sqlite.exec("PRAGMA foreign_keys = ON")
    for (const filename of readdirSync(MIGRATIONS_PATH)
      .filter((entry) => entry.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(path.join(MIGRATIONS_PATH, filename), "utf8"))
    }
  }

  prepare(sql) {
    return new PreparedStatement(this, sql)
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE")
    try {
      const results = statements.map((statement) => statement.execute())
      this.sqlite.exec("COMMIT")
      return results
    } catch (error) {
      this.sqlite.exec("ROLLBACK")
      throw error
    }
  }

  close() {
    this.sqlite.close()
  }
}

export function d1Fixture(context) {
  const database = new D1DatabaseFixture()
  context.after(() => database.close())
  return database
}
