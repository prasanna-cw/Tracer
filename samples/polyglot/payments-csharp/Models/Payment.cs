namespace Acme.Payments.Models;

public record Payment(string OrderId, decimal Amount)
{
    public string Capture() => $"{OrderId}:{Amount}";
}
