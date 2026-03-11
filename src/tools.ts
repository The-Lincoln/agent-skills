import { z } from 'zod';

// Zod schema for the weather lookup tool definition
export const weatherLookupSchema = z.object({
  location: z.string().min(1),
  date: z.string().optional(),
});

// Zod schema for the web search tool definition
export const webSearchSchema = z.object({
  query: z.string().min(1),
  resultsLimit: z.number().min(1).max(100).optional(),
});
