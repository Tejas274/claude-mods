/** One open pull request that also changes a file, as the band shows it (cleaned, never raw GitHub text) */
export type PullRef = {
  number: number
  /** cleaned and cut to 60 columns; '' when GitHub gave none */
  title: string
  /** a GitHub login, or '?' when it didn't look like one */
  login: string
  /** ms since the epoch, or null when GitHub's date didn't parse */
  updatedAt: number | null
}

/** The file Claude was about to edit and the open PRs that also change it */
export type Warning = {
  /** hashed repo key, so a warning from another repo can be told apart */
  repo: string
  /** repo-relative path, cleaned */
  path: string
  /** newest first */
  prs: PullRef[]
  /** when the edit happened */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    crosswalk: { warning: Warning | null }
  }
}
