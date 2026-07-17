import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { log } from './logger';

/**
 *
 * - One HTTP server bound to 127.0.0.1:0 serves authenticated channel paths.
 * The `approve` tool accepts tool name, input, and tool-use identity and returns
 *   {behavior: 'allow'|'deny', ...} theo PermissionPromptToolResultSchema
 * - The bot-provided handler renders a Discord prompt and waits for a decision.
 */

export interface ApprovalRequestArgs {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  permission_suggestions?: unknown[];
}

export interface ApprovalDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: unknown[];
}

export type ApprovalHandler = (
  channelId: string,
  args: ApprovalRequestArgs,
) => Promise<ApprovalDecision>;

interface ChannelServer {
  configPath: string | null;
  token: string;
}

const MAX_MCP_BODY_BYTES = 1024 * 1024;

export function isLoopbackAddress(remote: string): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

class ApprovalMcpServer {
  private httpServer: Server | null = null;
  private port = 0;
  private handler: ApprovalHandler | null = null;
  private channels = new Map<string, ChannelServer>();

  async start(handler: ApprovalHandler): Promise<number> {
    if (this.httpServer) return this.port;
    this.handler = handler;

    this.httpServer = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    log.dim(`ApprovalMcpServer: listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  async stop(): Promise<void> {
    for (const ch of this.channels.values()) {
      if (ch.configPath) {
        try {
          unlinkSync(ch.configPath);
        } catch {
          /* ignore */
        }
      }
    }
    this.channels.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  /**
   * Called before a Runner starts.
   */
  async registerChannel(channelId: string): Promise<string | null> {
    const existing = this.channels.get(channelId);
    if (existing) return existing.configPath;
    if (!this.handler) {
      log.warn('ApprovalMcpServer: registerChannel before start()');
      return null;
    }

    const configPath = join(
      tmpdir(),
      `clauderemote-mcp-${channelId}-${randomUUID().slice(0, 8)}.json`,
    );
    const token = randomUUID();
    const cfg = {
      mcpServers: {
        cr: {
          type: 'http',
          url: `http://127.0.0.1:${this.port}/mcp/${channelId}/${token}`,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });

    this.channels.set(channelId, { configPath, token });
    return configPath;
  }

  private createChannelMcpServer(channelId: string): McpServer {
    const mcpServer = new McpServer(
      { name: 'clauderemote', version: '0.6.0' },
      { capabilities: { tools: {} } },
    );

    mcpServer.registerTool(
      'approve',
      {
        title: 'Approve tool call',
        description:
          'Ask the Discord user to approve or deny this tool invocation.',
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()),
          tool_use_id: z.string().optional(),
          permission_suggestions: z.array(z.unknown()).optional(),
        },
      },
      async (args) => {
        try {
          log.dim(
            `ApprovalMcpServer[${channelId}] request ${args.tool_name}`,
          );
          const decision = await this.handler!(channelId, {
            tool_name: args.tool_name,
            input: args.input as Record<string, unknown>,
            tool_use_id: args.tool_use_id,
            permission_suggestions: args.permission_suggestions,
          });
          log.dim(
            `ApprovalMcpServer[${channelId}] decision ${decision.behavior}`,
          );
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(decision) },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`ApprovalMcpServer[${channelId}] handler err: ${msg}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  behavior: 'deny',
                  message: `Approval handler error: ${msg}`,
                }),
              },
            ],
          };
        }
      },
    );
    return mcpServer;
  }

  async unregisterChannel(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    if (ch.configPath) {
      try {
        unlinkSync(ch.configPath);
      } catch {
        /* ignore */
      }
    }
    this.channels.delete(channelId);
  }

  getPort(): number {
    return this.port;
  }

  getFullyQualifiedToolName(): string {
    return 'mcp__cr__approve';
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? '';
    if (!isLoopbackAddress(remote)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    const url = req.url ?? '';
    const match = url.match(/^\/mcp\/(\d+)\/([0-9a-f-]+)(\?.*)?$/i);
    if (!match) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const channelId = match[1];
    if (!channelId) {
      res.statusCode = 400;
      res.end('bad channel id');
      return;
    }
    const registered = this.channels.get(channelId);
    if (!registered || match[2] !== registered.token) {
      res.statusCode = 404;
      res.end('channel not registered');
      return;
    }

    let body: unknown = undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_MCP_BODY_BYTES) {
          res.statusCode = 413;
          res.end('request too large');
          return;
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end('bad json');
          return;
        }
      }
    }

    try {
      const mcpServer = this.createChannelMcpServer(channelId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      res.once('close', () => {
        void transport.close().catch(() => {});
        void mcpServer.close().catch(() => {});
      });
    } catch (err) {
      log.warn(
        `ApprovalMcpServer[${channelId}] transport err:`,
        err instanceof Error ? err.message : err,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('mcp transport error');
      }
    }
  }
}

export const approvalMcpServer = new ApprovalMcpServer();
