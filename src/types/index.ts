export interface NewsSource {
  id: string
  name: string
  url: string
  category: string
  weight: number | null
  isActive: number | null
  lastFetchedAt: number | null
  lastError: string | null
}

export interface NewsItem {
  id: string
  title: string
  summary: string | null
  url: string
  urlHash: string
  titleHash: string
  sourceId: string
  sourceName: string
  category: string
  publishedAt: number
  ingestedAt: number
  relevanceScore: number | null
  riskLevel: string | null
  riskReasons: string | null
  clusterId: string | null
  isProcessed: number | null
}

export interface EventCluster {
  id: string
  canonicalHeadline: string
  category: string
  relevanceScore: number | null
  riskLevel: string | null
  riskReasons: string | null
  sourceCount: number | null
  constituentItemIds: string
  constituentSummaries: string | null
  status: string | null
  topics: string | null
  firstSeenAt: number
  lastUpdatedAt: number
  postCount: number | null
}

export interface GeneratedPost {
  id: string
  clusterId: string
  contentMode: string
  content: string
  marketLink: string
  charCount: number
  estimatedScore: number | null
  scoreExplanation: string | null
  status: string | null
  rejectionReason: string | null
  postedAt: number | null
  reviewedBy: string | null
  larkMessageId: string | null
  larkSentAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Settings {
  id: string
  platformName: string | null
  marketBaseUrl: string | null
  autoGenerateThreshold: number | null
  postCooldownMinutes: number | null
  dailyPostLimit: number | null
  larkEnabled: number | null
  updatedAt: number
}
