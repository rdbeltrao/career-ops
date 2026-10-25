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
  kind?: "source" | "local";
  parentDocumentId?: string | null;
  sourceUrl?: string | null;
  sourceEditedAt?: string | null;
  importNotes?: string[];
  order?: number;
};

export type WorkspaceDocument = WorkspaceDocumentSummary & {
  content: string;
  revision: string;
  selectedSection?: string | null;
  selectedDocument?: string;
};

export type PageSelection = { document: string; section: string | null };
