import React from 'react';
import {
  Box,
  Card,
  Grid,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Chip,
  InputAdornment,
  Collapse,
  IconButton,
  Typography,
} from '@mui/material';
import {
  Search as SearchIcon,
  FilterList as FilterIcon,
  Clear as ClearIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
} from '@mui/icons-material';

export const FilterBar = ({
  searchValue,
  onSearchChange,
  filters = [],
  onFilterChange,
  onClearFilters,
  showClearAll = true,
  expanded = false,
  onToggleExpanded,
  searchPlaceholder = "Search...",
  className,
  children,
  ...props
}) => {
  const hasActiveFilters = filters.some(filter => 
    filter.value && filter.value !== '' && filter.value !== 'all'
  );

  const handleClearAll = () => {
    onSearchChange?.('');
    filters.forEach(filter => {
      onFilterChange?.(filter.key, filter.defaultValue || '');
    });
    onClearFilters?.();
  };

  return (
    <Card className={className} sx={{ mb: 3 }} {...props}>
      <Box sx={{ p: 2 }}>
        <Grid container spacing={2} alignItems="center">
          {/* Search Field */}
          <Grid item xs={12} sm={6} md={4}>
            <TextField
              fullWidth
              size="small"
              placeholder={searchPlaceholder}
              value={searchValue || ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 20 }} />
                  </InputAdornment>
                ),
                endAdornment: searchValue && (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => onSearchChange?.('')}
                      aria-label="clear search"
                    >
                      <ClearIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Grid>

          {/* Quick Filters (always visible) */}
          {filters
            .filter(filter => filter.alwaysVisible)
            .map((filter) => (
              <Grid item xs={12} sm={6} md={2} key={filter.key}>
                <FormControl fullWidth size="small">
                  <InputLabel>{filter.label}</InputLabel>
                  <Select
                    value={filter.value || filter.defaultValue || ''}
                    label={filter.label}
                    onChange={(e) => onFilterChange?.(filter.key, e.target.value)}
                  >
                    {filter.options.map((option) => (
                      <MenuItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            ))}

          {/* Expand/Collapse Button */}
          {filters.some(filter => !filter.alwaysVisible) && (
            <Grid item xs="auto">
              <Button
                variant="outlined"
                startIcon={<FilterIcon />}
                endIcon={expanded ? <CollapseIcon /> : <ExpandIcon />}
                onClick={() => onToggleExpanded?.(!expanded)}
                sx={{ minWidth: 120 }}
              >
                Filters
                {hasActiveFilters && (
                  <Chip
                    size="small"
                    label={filters.filter(f => f.value && f.value !== '' && f.value !== 'all').length}
                    sx={{ ml: 1, height: 16, fontSize: '0.7rem' }}
                    color="primary"
                  />
                )}
              </Button>
            </Grid>
          )}

          {/* Clear All Button */}
          {showClearAll && hasActiveFilters && (
            <Grid item xs="auto">
              <Button
                variant="outlined"
                size="small"
                startIcon={<ClearIcon />}
                onClick={handleClearAll}
                color="secondary"
              >
                Clear All
              </Button>
            </Grid>
          )}
        </Grid>

        {/* Expandable Filters */}
        <Collapse in={expanded}>
          <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <Grid container spacing={2}>
              {filters
                .filter(filter => !filter.alwaysVisible)
                .map((filter) => (
                  <Grid item xs={12} sm={6} md={3} key={filter.key}>
                    <FormControl fullWidth size="small">
                      <InputLabel>{filter.label}</InputLabel>
                      <Select
                        value={filter.value || filter.defaultValue || ''}
                        label={filter.label}
                        onChange={(e) => onFilterChange?.(filter.key, e.target.value)}
                      >
                        {filter.options.map((option) => (
                          <MenuItem key={option.value} value={option.value}>
                            {option.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                ))}
              
              {/* Custom filter content */}
              {children}
            </Grid>
          </Box>
        </Collapse>

        {/* Active Filters Display */}
        {hasActiveFilters && (
          <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
              Active filters:
            </Typography>
            {filters
              .filter(filter => filter.value && filter.value !== '' && filter.value !== 'all')
              .map((filter) => {
                const selectedOption = filter.options.find(opt => opt.value === filter.value);
                return (
                  <Chip
                    key={filter.key}
                    label={`${filter.label}: ${selectedOption?.label || filter.value}`}
                    size="small"
                    onDelete={() => onFilterChange?.(filter.key, filter.defaultValue || '')}
                    color="primary"
                    variant="outlined"
                  />
                );
              })}
          </Box>
        )}
      </Box>
    </Card>
  );
}; 