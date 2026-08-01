using System;
using System.IO;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace WindowsReferenceWinUi;

/// <summary>
/// The WinUI reference window behaviour. Semantically identical to the WPF
/// sibling: local-JSON state only, a Normal-risk submit, a high-risk "Delete
/// all" guarded by a modal <see cref="ContentDialog"/>, a controlled crash and a
/// reset. This gives the acceptance run a modern Windows UI stack to complement
/// the classic WPF one, both mapping to the same synthetic UIA fixture.
/// </summary>
public sealed partial class MainWindow : Window
{
    private sealed record ReferenceState(string Username, string Role, string[] Results);

    private static readonly string StatePath =
        Path.Combine(AppContext.BaseDirectory, "reference-state.json");

    public MainWindow()
    {
        InitializeComponent();
        LoadInitialState();
    }

    private void LoadInitialState()
    {
        var state = ReadState();
        UsernameEdit.Text = state.Username;
        ResultsList.Items.Clear();
        foreach (var item in state.Results)
        {
            ResultsList.Items.Add(item);
        }
    }

    private static ReferenceState ReadState()
    {
        if (File.Exists(StatePath))
        {
            var json = File.ReadAllText(StatePath);
            var parsed = JsonSerializer.Deserialize<ReferenceState>(json);
            if (parsed is not null)
            {
                return parsed;
            }
        }
        return new ReferenceState(string.Empty, "Viewer", Array.Empty<string>());
    }

    private void OnSubmit(object sender, RoutedEventArgs e)
    {
        ResultsList.Items.Add($"submitted:{UsernameEdit.Text}");
    }

    private async void OnDeleteAll(object sender, RoutedEventArgs e)
    {
        // Simulated high-risk action behind a modal dialog: exercises focus and
        // window changes AND the per-action local approval path in the Companion.
        var dialog = new ContentDialog
        {
            Title = "Confirm delete all",
            Content = "Delete all records? This is the simulated high-risk action.",
            PrimaryButtonText = "Delete all",
            CloseButtonText = "Cancel",
            XamlRoot = Content.XamlRoot,
        };
        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.Primary)
        {
            ResultsList.Items.Clear();
        }
    }

    private void OnCrash(object sender, RoutedEventArgs e)
    {
        // Controlled crash entry: deterministic process exit for crash-Finding
        // coverage. The only intentional termination path.
        Environment.FailFast("Reference App controlled crash");
    }

    private void OnReset(object sender, RoutedEventArgs e)
    {
        LoadInitialState();
    }
}
