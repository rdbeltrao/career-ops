export type WorkspaceSection = {
  id: string;
  title: string;
  level: number;
  parentId: string | null;
  start: number;
  bodyStart: number;
  end: number;
};

export type WorkspaceDocumentSummary = {
  id: string;
  title: string;
  group: string;
  description: string;
  exists: boolean;
  sections: WorkspaceSection[];
  error?: string;
  outlineWarning?: string;
  workspaceId?: string;
};

export type WorkspaceDocument = WorkspaceDocumentSummary & {
  content: string;
  revision: string;
  selectedSection?: string | null;
};

export type PageSelection = { document: string; section: string | null };
