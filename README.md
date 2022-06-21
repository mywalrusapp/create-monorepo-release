# create-monorepo-release

A lightweight NodeJS monorepo CLI tagging tool for creating independent releases using conventional commits.

## Background

We decided to create our own monorepo release tool because I couldn't find any
tool that met our needs. Our requirements were the following:

1. A repo is able to contain multiple projects with their respective package.json files.
2. A project version should to be tracked independently.
3. A version is bumped automatically based on the commit type. (ie. feat, fix, chore)
4. Only commits associated to the files in the project should be considered when bumping a project version.
5. If a file changed in a shared directory all commits would be considered when bumping a project version.

## Installation

```bash
# with NPM
$ npm install -g create-monorepo-release
# with YARN
$ yarn add --global create-monorepo-release
```

## Getting Started

To get started create a config file by running:

```bash
$ create-monorepo-release init
```



## License

MIT licensed (See LICENSE.txt)
