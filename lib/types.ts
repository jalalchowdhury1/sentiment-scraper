export type SentRow = {
  reportedDate: string; // e.g. "Jun 10"
  bullish: number;
  neutral: number;
  bearish: number;
  source: string; // which tier/method produced it
};
