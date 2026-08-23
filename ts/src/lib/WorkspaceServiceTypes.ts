export interface WorkspaceHost {
  uid: string;
  storage?: unknown;
  db?: unknown;
  // allow Firebase typed hosts to pass without strict overload errors
  [key: string]: unknown;
}
