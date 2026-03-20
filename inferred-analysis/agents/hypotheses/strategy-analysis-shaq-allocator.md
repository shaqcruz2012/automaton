# Strategy Analysis: Multi-Strategy Dynamic Allocator

**Capital**: $100,000 → $108,311.80 (3 months)
**Return**: 8.3% (≈33% annualized)

---

## Architecture Assessment

### Causal Temporal Convolutional Network (TCN)
- **Strength**: Preserves temporal ordering, no lookahead bias (causal convolutions), parallelizable (faster than RNNs)
- **Risk**: Fixed receptive field — may miss long-range dependencies. Dilated convolutions help but have a ceiling
- **Alpha source**: Captures local temporal patterns in price/volume data

### Graph Diffusion Strategy
- **Strength**: Models inter-asset relationships that linear models miss. Information propagates across a graph of correlated assets
- **Alpha source**: Cross-asset lead-lag relationships, sector rotation signals
- **Risk**: Graph structure may be stale — correlations shift in regime changes. Requires careful graph construction

### ETF Shock Propagation
- **Strength**: Captures sector contagion — when XLE drops, which single stocks follow and with what lag?
- **Alpha source**: Speed advantage — detecting sector-level shocks before they fully propagate to constituents
- **Risk**: Crowded signal if other quants trade the same propagation patterns

### Dynamic Portfolio Allocator
- **Strength**: Regime-aware capital allocation adapts to market conditions. Utility scoring creates a natural risk budget
- **Key insight**: Stronger strategies get more capital = self-correcting system
- **Risk**: Allocator may lag regime transitions — by the time it detects a new regime, the opportunity may have passed

---

## Performance Analysis

| Metric | Value | Assessment |
|--------|-------|------------|
| 3-month return | 8.3% | Strong |
| Annualized (extrapolated) | ~33% | Exceptional if sustained |
| Implied Sharpe (estimate) | 1.5-2.5 | Top decile for systematic strategies |
| vs S&P 500 Q1 typical | ~2-5% | Significant outperformance |

**Statistical significance**: 3 months = ~63 trading days. With daily returns, you need at least 6-12 months to establish significance at 95% confidence. The 8.3% return is **promising but not yet statistically significant** — could be explained by a favorable market regime.

**Key question**: What was the max drawdown during these 3 months? A 33% annualized return with 5% max drawdown is world-class. With 20% max drawdown, it's good but riskier.

---

## Risk Assessment

1. **Regime dependence**: The allocator infers regime from a state vector — what happens during regime transitions? Allocator may be slow to adapt, causing losses during the transition window

2. **Correlation risk**: Are TCN, graph diffusion, and ETF shock truly independent alpha sources? If all three are momentum-adjacent, a sharp reversal hits all simultaneously

3. **Overfitting risk**: Three ML models + an allocator = many parameters. 3 months of live data is insufficient to confirm the models aren't overfit to the training period

4. **Tail risk**: Graph diffusion may amplify losses in correlated selloffs — the graph structure that worked in calm markets may accelerate loss propagation in panics

5. **Capacity**: How much capital can this strategy absorb before market impact erodes returns? $100K is small; $10M may behave differently

---

## Scoring (Inferred Analysis 4-Dimension System)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Alpha Quality | 0.75 | Multi-source alpha (TCN + graph + ETF shock) is architecturally sound. Novelty of combining GNN with TCN is high. Sustainability uncertain at 3 months |
| Statistical Rigor | 0.40 | Only 3 months of live data. Need 12+ months minimum. No Sharpe confidence interval provided. No out-of-sample validation details |
| Risk-Adjusted Returns | 0.70 | 33% annualized is strong. Unknown drawdown profile prevents higher score. Allocator's utility scoring is a plus |
| Implementability | 0.85 | Already running with real capital. Proven implementable. Well-architected component system |

**Composite Score**: 0.67 (weighted: 0.30×0.75 + 0.25×0.40 + 0.25×0.70 + 0.20×0.85)

---

## Improvement Hypotheses (For Autoresearch Loop)

1. **Regime detection validation**: Can we replicate the state-vector regime detector in our backtest framework? Test different regime classification approaches (HMM, clustering, threshold-based)

2. **Correlation-aware sizing**: Add correlation monitoring to the allocator — reduce combined exposure when strategy correlations increase

3. **Graph construction methods**: Test different graph structures (correlation-based, Granger causality, mutual information) to find most predictive topology

4. **Drawdown-aware allocation**: Modify utility scoring to penalize strategies in drawdown, not just low-performing ones

5. **Additional components**: Add mean-reversion strategy as a diversifier — momentum + mean-reversion are naturally uncorrelated

---

## Recommendation

**Keep running. Extend to 12 months before scaling capital.**

The architecture is sound and the early results are promising. The multi-strategy + dynamic allocator design is exactly what institutional quant funds use. The key risk is insufficient data to confirm alpha persistence.

Next milestones:
- **Month 6**: If Sharpe > 1.5 and max drawdown < 15%, consider 2x capital
- **Month 12**: If sustained, this is a real edge. Scale to $500K+
- **Continuous**: Monitor strategy correlation — if all three start moving together, the diversification benefit is gone
