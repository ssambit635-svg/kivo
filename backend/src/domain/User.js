/** Domain entity: User. toJSON() is the ONLY sanctioned outward shape. */
export class User {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new User(row) : null;
  }

  get isAdmin() {
    return this.role === 'admin';
  }

  get isDisabled() {
    return this.status === 'disabled';
  }

  toJSON() {
    return {
      id: this.id,
      email: this.email,
      displayName: this.display_name,
      role: this.role,
      status: this.status,
      createdAt: this.created_at,
      lastLoginAt: this.last_login_at,
    };
  }
}
