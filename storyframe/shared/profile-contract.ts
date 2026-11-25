/** The caller's own workspace record. The owner id stays server-side. */
export interface ProfileRecord {
  displayName: string | null;
  workspaceName: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileResponse {
  ok: true;
  profile: ProfileRecord;
}
