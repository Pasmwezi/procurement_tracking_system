-- =============================================
-- v4 Migration: Basis of Selection for Award
-- Run this ONCE against an existing database
-- =============================================

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS basis_of_selection VARCHAR(50)
        CHECK (basis_of_selection IN ('lowest_price', 'lowest_price_per_point', 'highest_combined_rating')),
    ADD COLUMN IF NOT EXISTS minimum_points_threshold NUMERIC(10, 4),
    ADD COLUMN IF NOT EXISTS technical_weight_percent NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS price_weight_percent NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS maximum_technical_points NUMERIC(10, 4);
