using Acme.Payments.Services;
using Microsoft.AspNetCore.Mvc;

namespace Acme.Payments.Controllers;

public class PaymentsController : ControllerBase
{
    private readonly IPaymentService _payments;

    public PaymentsController(IPaymentService payments) => _payments = payments;

    public IActionResult Pay(string orderId, decimal amount)
    {
        if (amount <= 0) return BadRequest();
        return Ok(_payments.Charge(orderId, amount));
    }
}
