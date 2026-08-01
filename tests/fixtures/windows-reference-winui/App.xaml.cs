using Microsoft.UI.Xaml;

namespace WindowsReferenceWinUi;

/// <summary>
/// WinUI 3 application entry point. Activates the single <see cref="MainWindow"/>
/// on launch. No background activation, no protocol handlers, no network use.
/// </summary>
public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
