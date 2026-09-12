require('@nomicfoundation/hardhat-toolbox');

/**
 * Solidity is pinned to 0.8.30 to match the version Vela compiles its own
 * contracts with. LegateTrigger extends Vela's AbstractTrigger, so a mismatch
 * here would be compiling against a different base contract than the one
 * actually deployed.
 *
 * The Vela contracts come from a git submodule at lib/vela, wired in through
 * package.json as `"vela": "file:lib/vela/contracts"`. They are not published to
 * npm, and the repository root is a Go project rather than a package, so the
 * submodule points at the Hardhat project nested inside it. That makes imports
 * read `vela/contracts/...`, which is the path Vela's own documentation uses.
 *
 * After cloning, run:  git submodule update --init --depth 1
 */
module.exports = {
  solidity: {
    version: '0.8.30',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};
