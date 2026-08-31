export type ItemKind = "article" | "book";
export type FetchState = "queued" | "claimed" | "done" | "failed";

export type Item = {
  id: string;
  user_id: string;
  kind: ItemKind;
  url: string | null;
  title: string;
  author: string | null;
  created_at: string;
  ingested_at: string | null;
};

export type Annotation = {
  id: string;
  user_id: string;
  item_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type User = {
  id: string;
  subject: string;
  email: string | null;
  created_at: string;
};

export type ApiToken = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
};

export type FetchRequest = {
  id: string;
  user_id: string;
  item_id: string | null;
  url: string | null;
  source_path: string | null;
  state: FetchState;
  lease_expires_at: string | null;
  attempts: number;
  error_code: string | null;
  created_at: string;
};
