# Screenshots the Talos window by handle. No browser tool can reach a transparent
# always-on-top overlay, so this is how the character is actually verified.
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TalosFind {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
  public static IntPtr Found = IntPtr.Zero;
  public static string Info = "not found";
  static IntPtr best; static int bestArea;
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static void Scan() {
    best = IntPtr.Zero; bestArea = 0;
    EnumWindows((h,l) => {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (sb.ToString() == "Talos" && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        int a = (r.R-r.L)*(r.B-r.T);
        if (a > bestArea) { bestArea = a; best = h; Info = string.Format("{0},{1} {2}x{3}", r.L, r.T, r.R-r.L, r.B-r.T); }
      }
      return true;
    }, IntPtr.Zero);
    Found = best;
  }
  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
}
"@
[TalosFind]::Scan()
Write-Output ("window=" + [TalosFind]::Info)
if ([TalosFind]::Found -ne [IntPtr]::Zero) {
  $r = [TalosFind]::Rect([TalosFind]::Found)
  $w = $r.R - $r.L
  $h = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path (Split-Path $PSScriptRoot -Parent) 'talos-shot.png'))
  $g.Dispose(); $bmp.Dispose()
  Write-Output "captured exact window rect"
} else {
  Write-Output "NO VISIBLE Talos WINDOW"
}
