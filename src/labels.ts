import type { Role, Status } from './types';

export const STATUS_LABEL: Record<Status, string> = {
  ai: 'AI handling',
  needs_human: 'Needs human',
  human: 'Human handling',
  closed: 'Closed',
};

export const ROLE_LABEL: Record<Role, string> = {
  customer: 'Customer',
  ai: 'AI agent',
  human: 'You',
};
