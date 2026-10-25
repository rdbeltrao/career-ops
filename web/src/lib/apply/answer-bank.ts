import { pathToFileURL } from "node:url";
import { rootScript } from "@/lib/career-ops";
import type { ApplyField } from "./extract";

/**
 * Runtime handles on the core's answer writers. Loaded the way the Apply
 * checklist page loads application-answers.mjs: the core checkout is chosen at
 * runtime and is not bundled into the web build.
 */

export type BankAnswer = { q: string; a: string; kind: "free" | "select" | "field" | "file" };
export type BankRecord = { v: 1; date: string; state: "filled" | "submitted"; report: string | null; company: string; role: string; url: string; answers: BankAnswer[] };
export type PriorAnswer = { question: string; answer: string; company: string; date: string; state: string; class: string; sameCompany: boolean };
export type CompanyApplication = { date: string; state: string; role: string; report: string | null; url: string; answers: BankAnswer[] };
export type Snapshot = Record<string, unknown>;
export type DraftAnswers = Record<string, { value?: string; needs_confirmation?: boolean }>;

export type AnswerBankModule = {
  snapshotFromForm(input: { fields: { id: string; type: string; label: string }[]; answers: Record<string, string>; cvFile?: string | null }): Snapshot;
  bankRecordFromSnapshot(snapshot: Snapshot, meta: { date?: string; state: string; report?: string | null; company?: string; role?: string; url?: string }): BankRecord;
  appendBankRecord(root: string, record: BankRecord): boolean;
  readBank(root: string): { records: BankRecord[]; skipped: number };
  matchPriorAnswers(records: BankRecord[], fields: Pick<ApplyField, "id" | "type" | "label" | "options">[], opts: { company?: string }): Record<string, PriorAnswer>;
  guardAnswers(fields: Pick<ApplyField, "id" | "label">[], answers: DraftAnswers, priors: Record<string, PriorAnswer>): DraftAnswers;
  companyHistory(records: BankRecord[], company: string): CompanyApplication[];
  classifyQuestion(label: string): string;
  reportMeta(reportText: string): { company: string; role: string; url: string };
};

export type ApplicationAnswersModule = {
  upsertApplicationAnswersSection(reportText: string, snapshot: Snapshot): string;
};

export async function loadAnswerBank(): Promise<AnswerBankModule> {
  return (await import(/* webpackIgnore: true */ pathToFileURL(rootScript("answer-bank")).href)) as AnswerBankModule;
}

export async function loadApplicationAnswers(): Promise<ApplicationAnswersModule> {
  return (await import(/* webpackIgnore: true */ pathToFileURL(rootScript("application-answers")).href)) as ApplicationAnswersModule;
}
