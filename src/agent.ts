import { OpenRouter, tool, stepCountIs } from '@openrouter/sdk';
import type { Tool, StopCondition, StreamableOutputItem } from '@openrouter/sdk';
import { EventEmitter } from 'eventemitter3';
import { z } from 'zod';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Agent events for hooks (items-based streaming model)
export interface AgentEvents {
  'message:user': (message: Message) => void;
  'message:assistant': (message: Message) => void;
  'item:update': (item: StreamableOutputItem) => void;  // Items emitted with same ID, replace by ID
  'stream:start': () => void;
  'stream:delta': (delta: string, accumulated: string) => void;
  'stream:end': (fullText: string) => void;
  'tool:call': (name: string, args: unknown) => void;
  'tool:result': (name: string, result: unknown) => void;
  'reasoning:update': (text: string) => void;  // Extended thinking content
  'error': (error: Error) => void;
  'thinking:start': () => void;
  'thinking:end': () => void;
}

// Agent configuration
export interface AgentConfig {
  apiKey: string;
  model: string;
  tools?: Tool[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export class Agent extends EventEmitter<AgentEvents> {
  private config: AgentConfig;
  private messages: Message[] = [];
  private client: OpenRouter;

  constructor(config: AgentConfig) {
    super();
    this.config = {
      temperature: 0.7,
      maxTokens: 2000,
      ...config,
      tools: config.tools || [],
    };
    this.client = new OpenRouter({
      apiKey: this.config.apiKey,
    });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  addTool(newTool: Tool): void {
    this.config.tools.push(newTool);
  }

  // Send a message and get streaming response using items-based model
  // Items are emitted multiple times with the same ID but progressively updated content
  // Replace items by their ID rather than accumulating chunks
  async send(content: string): Promise<string> {
    const userMessage: Message = { role: 'user', content };
    this.messages.push(userMessage);
    this.emit('message:user', userMessage);

    try {
      this.emit('thinking:start');

      const result = await this.client.chat.completions.create({
        model: this.config.model,
        messages: this.messages,
        tools: this.config.tools.length > 0 ? this.config.tools : undefined,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      });

      this.emit('stream:start');
      let fullText = '';

      // Use getItemsStream() for items-based streaming (recommended)
      // Each item emission is complete - replace by ID, don't accumulate
      for await (const item of result.getItemsStream()) {
        // Emit the item for UI state management (use Map keyed by item.id)
        this.emit('item:update', item);

        switch (item.type) {
          case 'message':
            // Message items contain progressively updated content
            const textContent = item.content?.find((c: { type: string }) => c.type === 'output_text');
            if (textContent && 'text' in textContent) {
              const newText = textContent.text;
              if (newText !== fullText) {
                const delta = newText.slice(fullText.length);
                fullText = newText;
                this.emit('stream:delta', delta, fullText);
              }
            }
            break;
          case 'function_call':
            // Function call arguments stream progressively
            if (item.status === 'completed') {
              this.emit('tool:call', item.name, JSON.parse(item.arguments || '{}'));
            }
            break;
          case 'function_call_output':
            this.emit('tool:result', item.callId, item.output);
            break;
          case 'reasoning':
            // Extended thinking/reasoning content
            const reasoningText = item.content?.find((c: { type: string }) => c.type === 'reasoning_text');
            if (reasoningText && 'text' in reasoningText) {
              this.emit('reasoning:update', reasoningText.text);
            }
            break;
          // Additional item types: web_search_call, file_search_call, image_generation_call
        }
      }

      this.emit('stream:end', fullText);
      const assistantMessage: Message = { role: 'assistant', content: fullText };
      this.messages.push(assistantMessage);
      this.emit('message:assistant', assistantMessage);
      this.emit('thinking:end');

      return fullText;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      this.emit('thinking:end');
      throw err;
    }
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}