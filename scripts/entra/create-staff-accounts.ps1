<#
.SYNOPSIS
    Create the CareIN staff sign-in accounts in Microsoft Entra ID.

.DESCRIPTION
    Creates one cloud-only Entra user per roster entry below, matching the
    addresses seeded into app_user by
    backend/migrations/1786449600000_roles_spine.js. The two lists must agree:
    an Entra account with no matching app_user row degrades to the 'office'
    fallback (PR A) and will be LOCKED OUT once PR B turns that fallback off.

    NO LICENSE IS ASSIGNED. Signing in to the dashboard uses Entra ID only,
    which is free — a Microsoft 365 license is needed for mailboxes/Office, not
    for SSO. Assign licenses separately, to the people who actually need email.

    Idempotent: an account that already exists is reported and skipped, never
    modified. Re-running after adding a name to the roster creates only the new
    one. Nothing here deletes or disables anything.

    Each account is created with a random initial password printed once, and
    ForceChangePasswordNextSignIn — the person sets their own password at first
    sign-in.

.PARAMETER WhatIf
    Show what would be created without creating anything.

.PARAMETER TenantId
    Optional Entra tenant id to connect to. Omit to use the default from an
    existing Connect-MgGraph session or the interactive picker.

.EXAMPLE
    .\create-staff-accounts.ps1 -WhatIf
    .\create-staff-accounts.ps1

.NOTES
    Run manually, by Beau, in the careindent tenant. Nothing in CI touches this.
    Requires the Microsoft.Graph PowerShell SDK:
        Install-Module Microsoft.Graph -Scope CurrentUser
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $TenantId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# THE ROSTER — keep in lockstep with the ROSTER const in
# backend/migrations/1786449600000_roles_spine.js.
#
# Role is recorded here for the operator's benefit only; Entra knows nothing
# about it. The dashboard reads the role from app_user, not from Entra.
#
# admin@carein.ai is not listed: it already exists and is the platform
# super_admin.
# ---------------------------------------------------------------------------
$Roster = @(
    [pscustomobject]@{ Upn = 'holly@carein.ai';    DisplayName = 'Holly';    Role = 'admin' }
    [pscustomobject]@{ Upn = 'paola@carein.ai';    DisplayName = 'Paola';    Role = 'admin' }

    [pscustomobject]@{ Upn = 'sam@carein.ai';      DisplayName = 'Sam';      Role = 'office' }
    [pscustomobject]@{ Upn = 'krishana@carein.ai'; DisplayName = 'Krishana'; Role = 'office' }
    [pscustomobject]@{ Upn = 'jen@carein.ai';      DisplayName = 'Jen';      Role = 'office' }
    [pscustomobject]@{ Upn = 'aarionna@carein.ai'; DisplayName = 'Aarionna'; Role = 'office' }
    [pscustomobject]@{ Upn = 'hayley@carein.ai';   DisplayName = 'Hayley';   Role = 'office' }

    [pscustomobject]@{ Upn = 'raegan@carein.ai';   DisplayName = 'Raegan';   Role = 'hygiene' }
    [pscustomobject]@{ Upn = 'laura@carein.ai';    DisplayName = 'Laura';    Role = 'hygiene' }
    [pscustomobject]@{ Upn = 'cindy@carein.ai';    DisplayName = 'Cindy';    Role = 'hygiene' }
    [pscustomobject]@{ Upn = 'megan@carein.ai';    DisplayName = 'Megan';    Role = 'hygiene' }
    # Shared, rotated account for temp hygienists (explicit decision, 2026-08-11).
    # Rotate its password whenever a temp finishes.
    [pscustomobject]@{ Upn = 'temp@carein.ai';     DisplayName = 'Temp Hygienist'; Role = 'hygiene' }
)

$UsageLocation = 'US'

# ---------------------------------------------------------------------------

function New-InitialPassword {
    <#
      A long random initial password. It is shown once, typed once, and replaced
      at first sign-in (ForceChangePasswordNextSignIn). Built from an explicit
      alphabet with one character guaranteed from each class so it always
      satisfies the tenant's complexity policy.
    #>
    $lower = 'abcdefghijkmnopqrstuvwxyz'
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    $digit = '23456789'
    $sym = '!@#$%^&*-_=+'
    $all = $lower + $upper + $digit + $sym

    $chars = @(
        $lower[(Get-Random -Maximum $lower.Length)]
        $upper[(Get-Random -Maximum $upper.Length)]
        $digit[(Get-Random -Maximum $digit.Length)]
        $sym[(Get-Random -Maximum $sym.Length)]
    )
    $chars += 1..12 | ForEach-Object { $all[(Get-Random -Maximum $all.Length)] }
    -join ($chars | Sort-Object { Get-Random })
}

function Get-MailNickname {
    param([Parameter(Mandatory)][string] $Upn)
    ($Upn -split '@')[0]
}

# --- connect ---------------------------------------------------------------

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Users)) {
    throw 'Microsoft Graph PowerShell SDK not found. Install it with: Install-Module Microsoft.Graph -Scope CurrentUser'
}

Import-Module Microsoft.Graph.Users -ErrorAction Stop

$connectArgs = @{ Scopes = 'User.ReadWrite.All' }
if ($TenantId) { $connectArgs['TenantId'] = $TenantId }

Write-Host 'Connecting to Microsoft Graph...' -ForegroundColor Cyan
Connect-MgGraph @connectArgs | Out-Null

$context = Get-MgContext
Write-Host ("Connected to tenant {0} as {1}" -f $context.TenantId, $context.Account) -ForegroundColor Green
Write-Host ''

# --- create ----------------------------------------------------------------

$results = New-Object System.Collections.Generic.List[object]

foreach ($person in $Roster) {
    $upn = $person.Upn

    # Existence check first — this is what makes re-runs safe. Graph returns an
    # empty result (not an error) for an unknown UPN when -ErrorAction is
    # SilentlyContinue, so a genuine failure still surfaces below.
    $existing = $null
    try {
        $existing = Get-MgUser -UserId $upn -ErrorAction Stop
    } catch {
        $existing = $null
    }

    if ($existing) {
        Write-Host ("SKIP    {0} — already exists" -f $upn) -ForegroundColor DarkGray
        $results.Add([pscustomobject]@{
            Upn = $upn; DisplayName = $person.DisplayName; Role = $person.Role
            Action = 'skipped'; InitialPassword = ''
        })
        continue
    }

    if (-not $PSCmdlet.ShouldProcess($upn, 'Create Entra user')) {
        $results.Add([pscustomobject]@{
            Upn = $upn; DisplayName = $person.DisplayName; Role = $person.Role
            Action = 'would-create'; InitialPassword = ''
        })
        continue
    }

    $password = New-InitialPassword

    try {
        New-MgUser -ErrorAction Stop `
            -UserPrincipalName $upn `
            -DisplayName $person.DisplayName `
            -MailNickname (Get-MailNickname -Upn $upn) `
            -AccountEnabled `
            -UsageLocation $UsageLocation `
            -PasswordProfile @{
                Password                             = $password
                ForceChangePasswordNextSignIn        = $true
            } | Out-Null

        Write-Host ("CREATED {0}" -f $upn) -ForegroundColor Green
        $results.Add([pscustomobject]@{
            Upn = $upn; DisplayName = $person.DisplayName; Role = $person.Role
            Action = 'created'; InitialPassword = $password
        })
    } catch {
        Write-Host ("FAILED  {0} — {1}" -f $upn, $_.Exception.Message) -ForegroundColor Red
        $results.Add([pscustomobject]@{
            Upn = $upn; DisplayName = $person.DisplayName; Role = $person.Role
            Action = 'failed'; InitialPassword = ''
        })
    }
}

# --- summary ---------------------------------------------------------------

Write-Host ''
Write-Host 'Summary' -ForegroundColor Cyan
$results | Format-Table -AutoSize Upn, DisplayName, Role, Action, InitialPassword

$created = @($results | Where-Object { $_.Action -eq 'created' }).Count
$skipped = @($results | Where-Object { $_.Action -eq 'skipped' }).Count
$failed = @($results | Where-Object { $_.Action -eq 'failed' }).Count
Write-Host ("created: {0}   skipped: {1}   failed: {2}" -f $created, $skipped, $failed)

if ($created -gt 0) {
    Write-Host ''
    Write-Host 'The initial passwords above are shown ONCE. Hand each person theirs over a' -ForegroundColor Yellow
    Write-Host 'channel you trust; they will be forced to change it at first sign-in.' -ForegroundColor Yellow
    Write-Host 'Do not paste this table into email or chat that outlives the handoff.' -ForegroundColor Yellow
}

if ($failed -gt 0) {
    Write-Host ''
    Write-Host 'Some accounts failed. Fix the cause and re-run — existing accounts are skipped.' -ForegroundColor Red
    exit 1
}
