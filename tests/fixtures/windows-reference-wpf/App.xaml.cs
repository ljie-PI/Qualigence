using System.Windows;

namespace WindowsReferenceWpf;

/// <summary>
/// Application entry point for the WPF Reference App. Deliberately minimal: the
/// Companion launches the compiled executable as an ordinary interactive
/// process (no admin, no network), and all interactive surface lives in
/// <see cref="MainWindow"/>.
/// </summary>
public partial class App : Application
{
}
