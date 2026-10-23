package com.acme.billing

class BillingService {
    fun bill(orderId: String, cents: Long): Invoice {
        val invoice = Invoice(orderId, cents)
        if (cents > 100_000) {
            invoice.flagForReview()
        }
        return invoice
    }
}
