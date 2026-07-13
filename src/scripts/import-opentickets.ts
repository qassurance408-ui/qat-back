import fs from 'fs';
import path from 'path';

const API_BASE = 'https://qat.app.aletcloud.com/back';
const EMAIL = 'dagimsisay2005@gmail.com';
const PASSWORD = 'BORN1997';

const SERVICE_MAP: Record<string, string> = {
  'VPS / Compute': 'VPS',
  'App Hosting & Deployment': 'App Deployment',
  'Object Storage': 'Object Storage',
  'Databases': 'Databases',
  'Domains': 'Domains',
  'VPN Access': 'VPN Access',
  'AI / MCP': 'AI/MCP',
  'Other / Platform': 'Other/Platform',
  'Other / Platform (Call Center)': 'Other/Platform',
  'Call Center': 'Other/Platform',
};

const VALID_STATUSES = ['Open', 'Resolved', 'Closed'] as const;
const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;

interface TicketData {
  id: string;
  title: string;
  service: string;
  subCategory: string;
  status: string;
  severity: string;
  description: string;
  stepsToReproduce: string;
  expectedOutcome: string;
  actualOutcome: string;
  environment: string;
}

async function request(method: string, url: string, body?: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function login(): Promise<string> {
  console.log('Logging in...');
  const data = await request('POST', `${API_BASE}/api/auth/login`, { email: EMAIL, password: PASSWORD });
  console.log(`  Logged in as ${data.user.email}`);
  return data.accessToken;
}

async function findOrCreateWorkspace(token: string): Promise<string> {
  const wsId = 'opentickets-md';
  console.log(`\nEnsuring workspace "${wsId}"...`);

  const workspaces = await request('GET', `${API_BASE}/api/workspaces`, undefined, token);
  const existing = workspaces.find((w: any) => w.id === wsId);
  if (existing) {
    console.log(`  Workspace "${wsId}" already exists (role: ${existing.role})`);
    return wsId;
  }

  await request('POST', `${API_BASE}/api/workspaces`, { id: wsId, name: 'Open Tickets (opentickets.md)' }, token);
  console.log(`  Created workspace "${wsId}"`);
  return wsId;
}

/**
 * Parse the markdown file into structured ticket data.
 * Handles multi-line descriptions, steps-to-reproduce lists,
 * missing fields, and all edge cases.
 */
function parseTickets(): TicketData[] {
  const mdPath = path.resolve(process.env.HOME || '/home/dagim', 'Documents/Internship/opentickets.md');
  const content = fs.readFileSync(mdPath, 'utf-8');

  // Split into sections by ## headers
  const sectionBlocks = content.split(/\n(?=## )/);
  const tickets: TicketData[] = [];

  // Counter for generating fallback IDs
  let ticketCounter = 0;

  for (const sectionBlock of sectionBlocks) {
    const sectionLines = sectionBlock.split('\n');
    const sectionHeader = sectionLines[0].replace(/^##\s+/, '').trim();

    // Skip summary section and Object Storage (no open tickets)
    if (sectionHeader === 'Summary') continue;
    if (sectionHeader === 'Object Storage') continue;

    // Find all ticket blocks within this section — each starts with ### [ID] Title
    // and is separated by --- lines
    const ticketBlocks = sectionBlock.split(/\n---\n/);

    for (const block of ticketBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const firstLine = trimmed.split('\n')[0];
      const ticketMatch = firstLine.match(/^###\s+\[([^\]]*)\]\s+(.+)/);
      if (!ticketMatch) continue;

      const rawId = ticketMatch[1].trim() || '';
      const title = ticketMatch[2].trim();

      ticketCounter++;

      // Parse fields from the block
      const lines = trimmed.split('\n');

      const FIELD_MAP: Record<string, string> = {
        'ID': 'id',
        'Status': 'status',
        'Severity': 'severity',
        'Service': 'service',
        'Description': 'description',
        'Steps to Reproduce': 'stepsToReproduce',
        'Expected': 'expectedOutcome',
        'Actual': 'actualOutcome',
        'Environment': 'environment',
      };

      const fields: Record<string, string> = {
        id: rawId,
        title,
        status: 'Open',
        severity: 'Medium',
        service: sectionHeader,
        description: '',
        expectedOutcome: '',
        actualOutcome: '',
        environment: '',
        stepsToReproduce: '',
      };

      let currentField: string | null = null;
      let currentValue: string[] = [];
      let inStepsList = false;
      let stepsLines: string[] = [];

      // Process lines after the ### header
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Check for field header: `- **FieldName:** value`
        const fieldMatch = line.match(/^-\s+\*\*([^*:]+):\*\*\s*(.*)/);
        if (fieldMatch) {
          // Save previous field value
          if (currentField && (currentValue.length > 0 || stepsLines.length > 0)) {
            const mapped = FIELD_MAP[currentField];
            if (currentField === 'Steps to Reproduce' && stepsLines.length > 0) {
              fields.stepsToReproduce = stepsLines.join('\n');
            } else if (mapped && currentValue.length > 0) {
              fields[mapped] = currentValue.join('\n').trim();
            }
          }

          currentField = fieldMatch[1].trim();
          const rest = fieldMatch[2].trim();
          currentValue = rest ? [rest] : [];
          inStepsList = false;

          if (currentField === 'Steps to Reproduce') {
            inStepsList = true;
            stepsLines = [];
          }
          continue;
        }

        if (!currentField) continue;

        if (currentField === 'Steps to Reproduce') {
          // Numbered list item: `   N. text` or continuation
          const listMatch = line.match(/^\s+\d+\.\s+(.*)/);
          if (listMatch) {
            stepsLines.push(listMatch[1].trim());
          } else if (line.trim() && stepsLines.length > 0) {
            // Continuation of the last step (wrapped line)
            stepsLines[stepsLines.length - 1] += ' ' + line.trim();
          }
        } else {
          // Multi-line field continuation
          if (line.trim()) {
            currentValue.push(line.trim());
          }
        }
      }

      // Save last field
      if (currentField && (currentValue.length > 0 || stepsLines.length > 0)) {
        const mapped = FIELD_MAP[currentField];
        if (currentField === 'Steps to Reproduce' && stepsLines.length > 0) {
          fields.stepsToReproduce = stepsLines.join('\n');
        } else if (mapped && currentValue.length > 0) {
          fields[mapped] = currentValue.join('\n').trim();
        }
      }

      // Map service name
      const serviceLine = fields.service;
      const parts = serviceLine.split('·').map(s => s.trim());
      const sectionName = parts[0].trim();
      const mappedService = SERVICE_MAP[sectionName] || sectionName;
      let subCategory = parts.length > 1 ? parts.slice(1).join(' · ').trim() : '';

      // Map some known sub-category anomalies
      // "Other / Platform (Call Center)" — the "(Call Center)" part is informational, not a real subcategory
      if (sectionName === 'Call Center' || sectionName === 'Other / Platform (Call Center)') {
        subCategory = '';
      }

      // Map status
      let status = fields.status;
      if (status.includes('/')) status = status.split('/')[0].trim();
      if (!VALID_STATUSES.includes(status as any)) status = 'Open';

      // Map severity
      const severity = fields.severity;
      if (!VALID_SEVERITIES.includes(severity as any)) {
        fields.severity = 'Medium';
      }

      let description = fields.description;
      // Some descriptions have a "Description:" prefix already handled,
      // but also need to clean up any remaining header content
      if (description.startsWith('**') && description.includes('**')) {
        description = description.replace(/^\*\*[^*]+\*\*:\s*/, '');
      }

      // Build the ticket ID in TK-XXXX-XXXX format
      const ticketId = generateTicketId(rawId || title, mappedService, ticketCounter);

      const ticket: TicketData = {
        id: ticketId,
        title,
        service: mappedService,
        subCategory,
        status,
        severity: fields.severity,
        description,
        stepsToReproduce: fields.stepsToReproduce,
        expectedOutcome: fields.expectedOutcome,
        actualOutcome: fields.actualOutcome,
        environment: fields.environment,
      };

      tickets.push(ticket);
    }
  }

  return tickets;
}

function generateTicketId(existingId: string, service: string, index: number): string {
  const clean = existingId.replace(/[^A-Za-z0-9-]/g, '');
  if (clean && clean !== '-' && clean !== '') {
    const parts = clean.split('-');
    if (parts.length >= 2 && parts[0].length <= 10 && parts[1].length <= 10) {
      return `TK-${clean}`;
    }
  }
  const prefix = service.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'GEN';
  return `TK-${prefix}-${String(index).padStart(3, '0')}`;
}

async function importTickets(token: string, workspaceId: string, tickets: TicketData[]): Promise<void> {
  console.log(`\nImporting ${tickets.length} tickets into "${workspaceId}"...\n`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];

    const body = {
      id: t.id,
      title: t.title,
      service: t.service,
      subCategory: t.subCategory || '',
      status: t.status,
      severity: t.severity,
      dateReported: new Date().toISOString(),
      description: t.description || '',
      observed: '',
      stepsToReproduce: t.stepsToReproduce || '',
      expectedOutcome: t.expectedOutcome || '',
      actualOutcome: t.actualOutcome || '',
      rootCause: '',
      environment: t.environment || '',
    };

    try {
      await request('POST', `${API_BASE}/api/workspaces/${workspaceId}/tickets`, body, token);
      console.log(`  [${i + 1}/${tickets.length}] ✓ ${t.id}: ${t.title}`);
      created++;
    } catch (err: any) {
      if (err.message.includes('409')) {
        console.log(`  [${i + 1}/${tickets.length}] - ${t.id}: skipped (already exists)`);
        skipped++;
      } else {
        console.error(`  [${i + 1}/${tickets.length}] ✗ ${t.id}: ${err.message}`);
      }
    }
  }

  console.log(`\nDone! Created ${created}, skipped ${skipped}`);
}

async function main() {
  try {
    const token = await login();
    const workspaceId = await findOrCreateWorkspace(token);
    const tickets = parseTickets();
    await importTickets(token, workspaceId, tickets);
  } catch (err) {
    console.error('Fatal:', err);
    process.exit(1);
  }
}

main();
