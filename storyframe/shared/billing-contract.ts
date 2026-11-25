// ==========================================
// Phase 14: Actual Cost Ledger & Model-Price Matching
// ==========================================

export type CostProviderName =
  | "ollama"
  | "cloudflare"
  | "leonardo"
  | "deepgram-tts"
  | "deepgram-stt"
  | "json2video"
  | "r2";

export type CostPriceConfidence = "exact" | "estimated" | "unknown";

export interface ProviderRateCardEntry {
  provider: CostProviderName;
  modelOrTier: string;
  unitName: "1k_tokens" | "image" | "1k_chars" | "minute_audio" | "minute_video" | "gb_month";
  rateUsd: number | null;
  confidence: CostPriceConfidence;
  effectiveVersion: string;
  notes: string;
}

export interface CostLedgerEntryRecord {
  id: string;
  userId: string;
  projectId: string | null;
  provider: CostProviderName;
  modelOrTier: string;
  operation: string;
  units: number;
  unitName: ProviderRateCardEntry["unitName"];
  rateCardVersion: string;
  priceConfidence: CostPriceConfidence;
  estimatedCostUsd: number | null;
  reservedAllowanceUsd: number;
  reportedCostUsd: number | null;
  settledCostUsd: number | null;
  customerCreditAppliedUsd: number;
  promotionalCreditAppliedUsd: number;
  providerJobId: string | null;
  createdAt: string;
}

export interface ProjectCostSummary {
  projectId: string | null;
  rateCardVersion: string;
  totals: {
    estimatedUsd: number;
    reservedUsd: number;
    reportedUsd: number;
    settledUsd: number;
    customerCreditsUsd: number;
    promotionalCreditsUsd: number;
    unknownCount: number;
  };
  byProvider: Record<
    CostProviderName,
    {
      operations: number;
      units: number;
      settledOrEstimatedUsd: number;
      hasUnknownPricing: boolean;
    }
  >;
  entries: CostLedgerEntryRecord[];
}

// ==========================================
// Phase 15: Subscription Pricing & Payments
// ==========================================

export type SubscriptionPlanId = "creator" | "pro" | "studio";
export type BillingInterval = "monthly" | "annual";

export interface SubscriptionPlanDefinition {
  id: SubscriptionPlanId;
  name: string;
  monthlyPriceUsd: number;
  annualPriceUsd: number;
  seats: number;
  storageGb: number;
  brandKits: number;
  monthlyAiAllowanceUsd: number;
  sourceProcessingMinutes: number;
  renderAllowanceMinutes: number;
  maxConcurrentJobs: number;
  maxRepurposeBatchSize: number;
}

export interface UserEntitlementRecord {
  userId: string;
  planId: SubscriptionPlanId;
  billingInterval: BillingInterval;
  status: "active" | "past_due" | "canceled";
  seatsLimit: number;
  storageBytesLimit: number;
  brandKitsLimit: number;
  aiAllowanceUsdLimit: number;
  aiAllowanceUsdUsed: number;
  sourceMinutesLimit: number;
  sourceMinutesUsed: number;
  renderMinutesLimit: number;
  renderMinutesUsed: number;
  maxConcurrentJobs: number;
  maxRepurposeBatchSize: number;
  autoTopUpEnabled: boolean;
  spendingCeilingUsd: number | null;
  promotionalCreditsUsd: number;
  customerCreditsUsd: number;
  creditsExpiresAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  updatedAt: string;
}

export interface PreWorkChargeQuote {
  operation: string;
  provider: CostProviderName;
  estimatedChargeUsd: number;
  maximumChargeUsd: number;
  remainingAllowanceUsd: number;
  coveredByAllowance: boolean;
  requiresAutoTopUp: boolean;
  withinSpendingCeiling: boolean;
  allowed: boolean;
  reason: string | null;
}

export interface BillingWebhookEventRequest {
  eventId: string;
  eventType:
    | "subscription.activated"
    | "subscription.upgraded"
    | "invoice.payment_failed"
    | "subscription.canceled"
    | "credits.granted";
  planId?: SubscriptionPlanId;
  billingInterval?: BillingInterval;
  creditAmountUsd?: number;
  signature: string;
}

export const DEFAULT_RATE_CARD_VERSION = "2026-11-v1";

export const DEFAULT_PROVIDER_RATE_CARD: readonly ProviderRateCardEntry[] = [
  {
    provider: "ollama",
    modelOrTier: "gemma4:31b",
    unitName: "1k_tokens",
    rateUsd: 0.0004,
    confidence: "estimated",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Ollama Cloud direct token estimate",
  },
  {
    provider: "ollama",
    modelOrTier: "deepseek-v4.1-flash",
    unitName: "1k_tokens",
    rateUsd: 0.0003,
    confidence: "estimated",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Ollama Cloud flash reasoning estimate",
  },
  {
    provider: "ollama",
    modelOrTier: "glm-5.3-flash",
    unitName: "1k_tokens",
    rateUsd: 0.0003,
    confidence: "estimated",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Ollama Cloud structured JSON estimate",
  },
  {
    provider: "ollama",
    modelOrTier: "gpt-oss:20b",
    unitName: "1k_tokens",
    rateUsd: 0.00025,
    confidence: "estimated",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Ollama Cloud fast copywriting estimate",
  },
  {
    provider: "ollama",
    modelOrTier: "minimax-m3.1-flash",
    unitName: "1k_tokens",
    rateUsd: 0.0003,
    confidence: "estimated",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Ollama Cloud long-context estimate",
  },
  {
    provider: "cloudflare",
    modelOrTier: "@cf/black-forest-labs/flux-1-schnell",
    unitName: "image",
    rateUsd: 0.003,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Cloudflare Workers AI per-image rate",
  },
  {
    provider: "leonardo",
    modelOrTier: "phoenix-1.0",
    unitName: "image",
    rateUsd: 0.018,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Leonardo API credit conversion rate",
  },
  {
    provider: "deepgram-tts",
    modelOrTier: "aura-2-thalia-en",
    unitName: "1k_chars",
    rateUsd: 0.015,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Deepgram Aura-2 TTS per 1,000 characters",
  },
  {
    provider: "deepgram-stt",
    modelOrTier: "nova-2-general",
    unitName: "minute_audio",
    rateUsd: 0.0043,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Deepgram Nova-2 pre-recorded STT per minute (distinct from TTS)",
  },
  {
    provider: "json2video",
    modelOrTier: "v2-hd-30fps",
    unitName: "minute_video",
    rateUsd: 0.12,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "JSON2Video v2 1080p render per minute",
  },
  {
    provider: "r2",
    modelOrTier: "standard-private",
    unitName: "gb_month",
    rateUsd: 0.015,
    confidence: "exact",
    effectiveVersion: DEFAULT_RATE_CARD_VERSION,
    notes: "Cloudflare R2 private object storage per GB-month",
  },
];

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlanDefinition[] = [
  {
    id: "creator",
    name: "Creator",
    monthlyPriceUsd: 29,
    annualPriceUsd: 290,
    seats: 1,
    storageGb: 25,
    brandKits: 2,
    monthlyAiAllowanceUsd: 10,
    sourceProcessingMinutes: 120,
    renderAllowanceMinutes: 30,
    maxConcurrentJobs: 1,
    maxRepurposeBatchSize: 3,
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: 79,
    annualPriceUsd: 790,
    seats: 3,
    storageGb: 100,
    brandKits: 10,
    monthlyAiAllowanceUsd: 35,
    sourceProcessingMinutes: 450,
    renderAllowanceMinutes: 120,
    maxConcurrentJobs: 3,
    maxRepurposeBatchSize: 8,
  },
  {
    id: "studio",
    name: "Studio",
    monthlyPriceUsd: 199,
    annualPriceUsd: 1990,
    seats: 10,
    storageGb: 500,
    brandKits: 50,
    monthlyAiAllowanceUsd: 100,
    sourceProcessingMinutes: 1500,
    renderAllowanceMinutes: 400,
    maxConcurrentJobs: 6,
    maxRepurposeBatchSize: 15,
  },
];

export function findSubscriptionPlan(planId: SubscriptionPlanId): SubscriptionPlanDefinition {
  return SUBSCRIPTION_PLANS.find((plan) => plan.id === planId) ?? SUBSCRIPTION_PLANS[0];
}
