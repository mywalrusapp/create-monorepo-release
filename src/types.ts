export interface Config {
  debug?: boolean;
  includeChangelog?: boolean;
  mainBranch?: string;
  projects?: string[];
  common?: string[];
  prefixRules?: {
    major: string[];
    minor: string[];
    patch: string[];
  };
}
