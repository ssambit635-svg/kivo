import { ageFromDob } from '../utils/time.js';

/** Domain entity: a family member whose health data belongs to one owner account. */
export class Member {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new Member(row) : null;
  }

  get age() {
    return this.dob ? ageFromDob(this.dob) : null;
  }

  get familyHistory() {
    try {
      return JSON.parse(this.family_history || '{}');
    } catch {
      return {};
    }
  }

  /** @param {string|null} accessLevel 'owner' | 'viewer' | 'editor' | null */
  toJSON(accessLevel = null) {
    return {
      id: this.id,
      ownerUserId: this.user_id,
      name: this.name,
      relationship: this.relationship,
      dob: this.dob,
      age: this.age,
      sex: this.sex,
      heightCm: this.height_cm,
      familyHistory: this.familyHistory,
      access: accessLevel,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}
