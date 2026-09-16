import { newId } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

/**
 * Base class for repositories: shared DB handle + helpers.
 * Repositories NEVER perform authorization — that is the service layer's
 * job — but they do honor explicit scoping filters passed to them.
 */
export class BaseRepository {
  constructor(db) {
    this.db = db;
    this.table = '';
  }

  id() {
    return newId();
  }

  now() {
    return nowIso();
  }

  count(where = '1=1', params = []) {
    const row = this.db.get(`SELECT COUNT(*) AS c FROM ${this.table} WHERE ${where}`, ...params);
    return row ? row.c : 0;
  }
}
