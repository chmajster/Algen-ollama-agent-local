function Format-ExternalCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $executable = Split-Path -Leaf $FilePath
    $displayArguments = $Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
    }
    return (@($executable) + $displayArguments) -join ' '
}

Export-ModuleMember -Function Format-ExternalCommand
