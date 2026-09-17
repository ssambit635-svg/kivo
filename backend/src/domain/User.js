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

  get roles() {
    // Resolved per request by AuthService (admin flag + granted product roles).
    return this._roles || [this.role === 'admin' ? 'admin' : 'patient'];
  }

  set roles(value) {
    this._roles = Array.isArray(value) ? value : null;
  }

  get isDoctor() {
    return this.roles.includes('doctor');
  }

  toJSON() {
    return {
      id: this.id,
      email: this.email,
      displayName: this.display_name,
      // `role` keeps its original DB meaning (user|admin); `accountType` and
      // `roles` are the RBAC view the two consoles route on.
      role: this.role,
      accountType: this.roles.includes('doctor') ? 'doctor' : this.role === 'admin' ? 'admin' : 'patient',
      roles: this.roles,
      status: this.status,
      consentedAt: this.consented_at ?? null,
      consentVersion: this.consent_version ?? null,
      createdAt: this.created_at,
      lastLoginAt: this.last_login_at,
    };
  }
}
