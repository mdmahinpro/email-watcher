export * from "./generated/api";

// Re-export TS types from generated/types, but skip types whose names collide
// with runtime zod schemas of the same name (CreateAccountBody,
// UpdateAccountBody, UpdateSettingsBody, CreateAccountsBulkBody,
// CreateHostingerAccountsBody).
// For those, infer types from the zod schemas instead via z.infer<typeof Schema>.
export type { AccountActivity } from "./generated/types/accountActivity";
// The generated module exports a type and a const of the same name; re-export
// both so callers can use `AccountProvider` as a type and read its members.
export { AccountProvider } from "./generated/types/accountProvider";
export type { AppSettings } from "./generated/types/appSettings";
export type { AuthSession } from "./generated/types/authSession";
export type { BulkAccountEntry } from "./generated/types/bulkAccountEntry";
export type { BulkCreateFailure } from "./generated/types/bulkCreateFailure";
export type { BulkCreateResult } from "./generated/types/bulkCreateResult";
// Type and const of the same name, as with AccountProvider.
export { CaptureMode } from "./generated/types/captureMode";
export type { EmailAccount } from "./generated/types/emailAccount";
export type { HealthStatus } from "./generated/types/healthStatus";
export type { HostingerDefaults } from "./generated/types/hostingerDefaults";
export type { HostingerMailbox } from "./generated/types/hostingerMailbox";
export type { InboxMessage } from "./generated/types/inboxMessage";
export type { KeywordCount } from "./generated/types/keywordCount";
export type { ListAccountsParams } from "./generated/types/listAccountsParams";
export type { ListInboxMessagesParams } from "./generated/types/listInboxMessagesParams";
export type { ListMessagesParams } from "./generated/types/listMessagesParams";
export type { MatchedMessage } from "./generated/types/matchedMessage";
export type { MessageDetail } from "./generated/types/messageDetail";
export type { ScanResult } from "./generated/types/scanResult";
export type { StatsSummary } from "./generated/types/statsSummary";
export type { TestResult } from "./generated/types/testResult";
