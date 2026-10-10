// Pure readings of a shell command's text: no host access, so tests import them directly.

const READ_ONLY_COMMAND =
  /^(ls|dir|cat|type|head|tail|less|more|wc|grep|egrep|rg|find|pwd|cd|echo|which|where|tree|stat|file|du|df|env|printenv|git\s+(log|diff|status|show|branch|rev-parse|ls-files|blame|remote|fetch)|Get-ChildItem|gci|Get-Content|gc|Get-Item|Get-Location|Select-String|Test-Path|Resolve-Path|Measure-Object|Write-Output|Write-Host|Set-Location)\b/i

/** True when every part of the command only reads: then no git status runs around it. */
export function isReadOnlyCommand(command: string): boolean {
  if (/>|\b(tee|xargs|sed\s+-i)\b|-exec\b|-delete\b|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item/i.test(command)) {
    return false
  }
  return command.split(/&&|\|\||[;|\n]/).every(part => part.trim() === '' || READ_ONLY_COMMAND.test(part.trim()))
}

/** Splits a command into words, honouring single and double quotes. */
export function words(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

/** The plain file arguments of delete commands, for folders outside git. */
export function deleteTargets(command: string): string[] {
  const targets: string[] = []
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const [verb, ...args] = words(part.trim())
    if (!verb || !/^(rm|del|erase|Remove-Item|ri)$/i.test(verb)) continue
    for (const arg of args) {
      if (/^-/.test(arg) || /^\/[a-z]$/i.test(arg)) continue
      targets.push(arg)
    }
  }
  return targets
}

