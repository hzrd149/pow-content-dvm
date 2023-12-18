import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { SQLITE_DB } from "./env.js";
import path from "node:path";

const db = await open({
  filename: SQLITE_DB,
  driver: sqlite3.Database,
});

export default db;
