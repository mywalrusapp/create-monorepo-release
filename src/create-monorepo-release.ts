#!/usr/bin/env node

import parser from '@commitlint/parse';
import { program } from 'commander';
import * as conventionalChangelog from 'conventional-changelog';
import { createWriteStream } from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as semver from 'semver';
import sgit from 'simple-git';
import { Config } from './types';

const IGNORE_FILES_REGEX = /node_modules/g;
const CONFIG_FILENAME = '.create-monorepo-release.json';

let git = sgit();

enum ReleaseType {
  None = 0,
  Patch,
  Minor,
  Major,
}

class CliError extends Error {}

const getReleaseType = (commitType: string) => {
  switch (commitType) {
    case 'BREAKING CHANGE':
      return ReleaseType.Major;
    case 'feat':
      return ReleaseType.Minor;
    case 'fix':
    case 'perf':
    case 'chore':
      return ReleaseType.Patch;
    default:
      return ReleaseType.None;
  }
};

const getNextVersion = (currentVersion: string, releaseType: ReleaseType) => {
  switch (releaseType) {
    case ReleaseType.Major:
      return semver.inc(currentVersion, 'major');
    case ReleaseType.Minor:
      return semver.inc(currentVersion, 'minor');
    case ReleaseType.Patch:
      return semver.inc(currentVersion, 'patch');
  }
  return null;
};

const writeChangelog = (filename: string, options?: { tagPrefix?: string; from?: string; to?: string; path?: string }) =>
  new Promise((resolve, reject) => {
    const writer = createWriteStream(filename);
    writer.write('# Changelog\n\n');
    conventionalChangelog({
      preset: 'conventionalcommits',
      pkg: { path: options.path },
      append: true,
      tagPrefix: options?.tagPrefix,
      config: {
        gitRawCommitsOpts: { path: options.path, from: options.from, to: options.to },
      },
    }).pipe(writer);

    writer.on('finish', resolve);
    writer.on('error', reject);
  });

const runAsync =
  (callback: (...args: any[]) => Promise<void>) =>
  (...args) => {
    callback(...args).catch(err => {
      if (err instanceof CliError) {
        console.error(err.message);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
  };

const loadConfig = async () => {
  const configFile = path.join(process.cwd(), '/', CONFIG_FILENAME);

  if (!fse.existsSync(configFile)) {
    throw new CliError('No config file found. Did you run "create-monorepo-release init"?');
  }
  const json: Config = await fse.readJSON(configFile);

  if (!json.projects) {
    throw new CliError('Missing "projects" property in config');
  }

  return json;
};

const cleanup = async () => {
  if ((await git.stashList()).latest?.message === 'RELEASE IT STASH') {
    await git.stash(['pop']);
  }
};

async function init() {
  const configFile = path.join(process.cwd(), '/', CONFIG_FILENAME);

  if (fse.existsSync(configFile)) {
    throw new CliError('A config already exists. Did you mean to run "create-monorepo-release release"?');
  }

  const findProjects = async basePath => {
    const results: string[] = [];
    const files = await fse.readdir(basePath);
    for (const filename of files) {
      const fullFilename = path.join(basePath, filename);
      const stat = await fse.stat(fullFilename);
      if (stat.isDirectory() && !IGNORE_FILES_REGEX.test(filename)) {
        const subFiles = await findProjects(fullFilename);
        results.push(...subFiles);
      } else if (stat.isFile() && /^package\.json$/g.test(filename)) {
        results.push(fullFilename);
      }
    }
    return results;
  };
  const projectPackageFiles = await findProjects(process.cwd());
  const projects = projectPackageFiles
    .map(filename => filename.replace(`${process.cwd()}/`, '').replace(/(^|\/)package\.json$/g, ''))
    .filter(Boolean);
  console.log(`found ${projects.length} projects(s)`);

  const isRepo = await git.checkIsRepo();

  const { current: currentBranch } = await git.status();

  if (!isRepo) {
    throw new Error('Not in a git repository');
  }

  await fse.writeJSON(
    path.join(process.cwd(), '/', CONFIG_FILENAME),
    {
      debug: true,
      includeChangelog: true,
      mainBranch: currentBranch,
      projects,
      common: [],
    },
    { spaces: 2 },
  );

  console.log('config file generated');
}

async function release(options: { dryRun?: boolean; push?: boolean; gitUsername?: string; gitEmail?: string }) {
  try {
    if (options.gitUsername) {
      git.addConfig('user.name', options.gitUsername);
    }
    if (options.gitEmail) {
      git.addConfig('user.email', options.gitEmail);
    }

    const isDryRun = options.dryRun;
    const { projects, common } = await loadConfig();
    const { all: tags } = await git.tags();
    const packageReleases = new Map<string, string>();

    await git.stash(['push', '-m', 'RELEASE IT STASH']);

    for (const name of projects) {
      const packagePath = path.join(process.cwd(), '/', name);
      const packageFilename = path.join(packagePath, '/package.json');
      const changelogFilename = path.join(packagePath, '/CHANGELOG.md');
      const json = await fse.readJSON(packageFilename);
      const lastTagName = tags.includes(`${name}-${json.version}`) ? `${name}-${json.version}` : undefined;

      const { hash: tagHash } = lastTagName ? (await git.log([lastTagName])).latest : { hash: undefined };

      const logsSince = (await git.log({ file: packagePath, from: tagHash, to: 'HEAD' })).all;

      let releaseType: ReleaseType = ReleaseType.None;
      for (const { message } of logsSince) {
        const commitConvention = await parser(message);
        const commitReleaseType = getReleaseType(commitConvention.type);
        if (commitReleaseType > releaseType) {
          releaseType = commitReleaseType;
        }
      }

      const nextVersion = getNextVersion(json.version, releaseType);

      if (!nextVersion) {
        console.log(`no release required for ${name}`);
        continue;
      }

      if (isDryRun) {
        console.debug(`would have bumped ${name}/package.json to ${nextVersion}`);
      } else {
        let rawPackageJson = await fse.readFile(packageFilename, 'utf-8');
        rawPackageJson = rawPackageJson.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${nextVersion}"`);
        await fse.writeFile(packageFilename, rawPackageJson, 'utf-8');
        console.log(`bumped ${name}/package.json`);
        await git.add(packageFilename);
      }

      if (isDryRun) {
        console.debug(`would have written ${name}/CHANGELOG.md`);
      } else {
        await writeChangelog(changelogFilename, { tagPrefix: name, path: packagePath, from: tagHash, to: 'HEAD' });
        console.log(`change log ${name}/CHANGELOG.md updated`);
        await git.add(changelogFilename);
      }
      packageReleases.set(name, nextVersion);
    }

    if (isDryRun) {
      console.debug('would have committed release changes');
    } else {
      await git.commit(`chore: created release`);
    }

    for (const name of projects) {
      if (!packageReleases.has(name)) {
        continue;
      }
      const nextVersion = packageReleases.get(name);
      if (isDryRun) {
        console.debug(`would have created tag ${name}-${nextVersion}`);
      } else {
        await git.addTag(`${name}-${nextVersion}`);
        console.log(`tag ${name}-${nextVersion} created`);
      }
    }

    if (isDryRun) {
      console.debug('would have pushed all tags');
    } else if (options.push) {
      await git.push('origin');
      await git.pushTags();
      console.log('pushed main branch changes and all tags');
    }

    await cleanup();
    console.log('release complete');
  } catch (err) {
    await git.reset();
    await cleanup();
    throw err;
  }
}

function main() {
  program
    // init command
    .command('init')
    .description('generates a new config file')
    .action(runAsync(init));

  program
    // release command
    .command('release')
    .description('creates a new release for all projects')
    .option('--dry-run', 'Does not perform write operations')
    .option('--push', 'Pushes all changes and tags to remote branch')
    .option('--git.username', 'Username to use for tagging')
    .option('--git.email', 'Email to use for tagging')
    .action(runAsync(release));

  program.parse();
}

main();
