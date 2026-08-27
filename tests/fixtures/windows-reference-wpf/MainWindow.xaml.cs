using System;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace WindowsReferenceWpf;

/// <summary>
/// The reference window behaviour. All state is loaded from and reset to a local
/// JSON file (<c>reference-state.json</c>) beside the executable — no network, no
/// registry, no elevation. Each control's behaviour is intentionally simple and
/// deterministic so the manual Windows-11 checklist can verify UIA capture,
/// action resolution, approval flows, crash Findings and reset against the same
/// scenarios the Linux suite drives via reference-app.fixture.json.
/// </summary>
public partial class MainWindow : Window
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
        SelectRole(state.Role);
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

    private void SelectRole(string role)
    {
        foreach (var item in RoleCombo.Items)
        {
            if (item is ComboBoxItem comboBoxItem && string.Equals(comboBoxItem.Content?.ToString(), role, StringComparison.Ordinal))
            {
                RoleCombo.SelectedItem = comboBoxItem;
                return;
            }
        }
    }

    private void OnSubmit(object sender, RoutedEventArgs e)
    {
        // Normal-risk state change: append the typed username and selected role to the results.
        var role = (RoleCombo.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? RoleCombo.Text;
        ResultsList.Items.Add($"submitted:{UsernameEdit.Text}:{role}");
    }

    private void OnDeleteAll(object sender, RoutedEventArgs e)
    {
        // Simulated destructive / high-risk action. In the real acceptance run
        // this is the action that must trigger a per-action local approval prompt
        // in the Companion before it can proceed.
        var confirm = MessageBox.Show(
            this,
            "Delete all records? This is the simulated high-risk action.",
            "Confirm delete all",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning);
        if (confirm == MessageBoxResult.OK)
        {
            ResultsList.Items.Clear();
        }
    }

    private void OnCrash(object sender, RoutedEventArgs e)
    {
        // Controlled crash entry: produces a deterministic process exit so the
        // Runner emits a high-confidence crash Finding that the Oracle must not
        // suppress. This is the only path that intentionally terminates the app.
        Environment.FailFast("Reference App controlled crash");
    }

    private void OnReset(object sender, RoutedEventArgs e)
    {
        // Restore the known initial state from the local JSON file only.
        LoadInitialState();
    }
}
