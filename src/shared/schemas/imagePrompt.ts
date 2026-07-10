import { z } from 'zod'

export const ImagePromptSchema = z.object({
  sceneDescription: z
    .string()
    .describe('Which visible moment from the chapter is depicted (spoiler-safe: only what the reader has already read).'),
  prompt: z
    .string()
    .describe('Full image-generation prompt for the scene, excluding the style block (prepended separately).')
})
export type ImagePrompt = z.infer<typeof ImagePromptSchema>

export const ImageStyleBlockSchema = z.object({
  styleBlock: z
    .string()
    .describe(
      'Locked style block prepended verbatim to every illustration prompt: medium, palette with hex anchors, lighting, linework, era. Must include: no text, no watermark, no frames.'
    )
})
export type ImageStyleBlock = z.infer<typeof ImageStyleBlockSchema>
