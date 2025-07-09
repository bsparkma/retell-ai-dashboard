import React from 'react';
import {
  Skeleton,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Box,
  Grid,
} from '@mui/material';

// Card Skeleton
export const CardSkeleton = ({ height = 200, ...props }) => (
  <Card {...props}>
    <CardContent>
      <Skeleton variant="text" width="60%" height={24} sx={{ mb: 2 }} />
      <Skeleton variant="rectangular" width="100%" height={height - 80} />
      <Box sx={{ mt: 2, display: 'flex', gap: 1 }}>
        <Skeleton variant="rectangular" width={80} height={32} />
        <Skeleton variant="rectangular" width={80} height={32} />
      </Box>
    </CardContent>
  </Card>
);

// Chart Skeleton
export const ChartSkeleton = ({ height = 300, title = true }) => (
  <Card>
    <CardContent>
      {title && (
        <Skeleton variant="text" width="40%" height={28} sx={{ mb: 2 }} />
      )}
      <Skeleton variant="rectangular" width="100%" height={height} sx={{ borderRadius: 1 }} />
      <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', gap: 2 }}>
        <Skeleton variant="circular" width={12} height={12} />
        <Skeleton variant="text" width={60} height={16} />
        <Skeleton variant="circular" width={12} height={12} />
        <Skeleton variant="text" width={60} height={16} />
        <Skeleton variant="circular" width={12} height={12} />
        <Skeleton variant="text" width={60} height={16} />
      </Box>
    </CardContent>
  </Card>
);

// Table Skeleton
export const TableSkeleton = ({ rows = 5, columns = 4 }) => (
  <TableContainer>
    <Table>
      <TableHead>
        <TableRow>
          {Array.from({ length: columns }).map((_, index) => (
            <TableCell key={index}>
              <Skeleton variant="text" width="80%" height={20} />
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <TableRow key={rowIndex}>
            {Array.from({ length: columns }).map((_, colIndex) => (
              <TableCell key={colIndex}>
                <Skeleton 
                  variant="text" 
                  width={colIndex === 0 ? "60%" : "100%"} 
                  height={20} 
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableContainer>
);

// Stats Card Skeleton
export const StatsCardSkeleton = () => (
  <Card>
    <CardContent>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box>
          <Skeleton variant="text" width={120} height={20} />
          <Skeleton variant="text" width={80} height={32} sx={{ mt: 1 }} />
        </Box>
        <Skeleton variant="circular" width={48} height={48} />
      </Box>
      <Skeleton variant="text" width="40%" height={16} />
    </CardContent>
  </Card>
);

// Dashboard Grid Skeleton
export const DashboardSkeleton = () => (
  <Grid container spacing={3}>
    {/* Stats Cards */}
    <Grid item xs={12} sm={6} md={3}>
      <StatsCardSkeleton />
    </Grid>
    <Grid item xs={12} sm={6} md={3}>
      <StatsCardSkeleton />
    </Grid>
    <Grid item xs={12} sm={6} md={3}>
      <StatsCardSkeleton />
    </Grid>
    <Grid item xs={12} sm={6} md={3}>
      <StatsCardSkeleton />
    </Grid>
    
    {/* Charts */}
    <Grid item xs={12} md={6}>
      <ChartSkeleton height={300} />
    </Grid>
    <Grid item xs={12} md={6}>
      <ChartSkeleton height={300} />
    </Grid>
    
    {/* Table */}
    <Grid item xs={12}>
      <Card>
        <CardContent>
          <Skeleton variant="text" width="30%" height={28} sx={{ mb: 2 }} />
          <TableSkeleton rows={8} columns={6} />
        </CardContent>
      </Card>
    </Grid>
  </Grid>
);

// Analytics Skeleton
export const AnalyticsSkeleton = () => (
  <Grid container spacing={3}>
    <Grid item xs={12} md={6}>
      <ChartSkeleton title height={300} />
    </Grid>
    <Grid item xs={12} md={6}>
      <ChartSkeleton title height={300} />
    </Grid>
    <Grid item xs={12} md={6}>
      <ChartSkeleton title height={300} />
    </Grid>
    <Grid item xs={12} md={6}>
      <ChartSkeleton title height={300} />
    </Grid>
  </Grid>
);

// Agent Card Skeleton
export const AgentCardSkeleton = () => (
  <Card>
    <CardContent>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Skeleton variant="circular" width={48} height={48} sx={{ mr: 2 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Skeleton variant="text" width="60%" height={24} />
          <Skeleton variant="text" width="40%" height={20} />
        </Box>
        <Skeleton variant="rectangular" width={60} height={24} sx={{ borderRadius: 3 }} />
      </Box>
      <Skeleton variant="text" width="100%" height={16} sx={{ mb: 1 }} />
      <Skeleton variant="text" width="80%" height={16} sx={{ mb: 2 }} />
      <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
        <Skeleton variant="rectangular" width={50} height={20} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" width={60} height={20} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rectangular" width={45} height={20} sx={{ borderRadius: 3 }} />
      </Box>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Skeleton variant="rectangular" width={80} height={32} sx={{ borderRadius: 1 }} />
        <Skeleton variant="rectangular" width={80} height={32} sx={{ borderRadius: 1 }} />
      </Box>
    </CardContent>
  </Card>
);

// List Skeleton
export const ListSkeleton = ({ items = 5 }) => (
  <Box>
    {Array.from({ length: items }).map((_, index) => (
      <Box key={index} sx={{ display: 'flex', alignItems: 'center', py: 2 }}>
        <Skeleton variant="circular" width={40} height={40} sx={{ mr: 2 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Skeleton variant="text" width="60%" height={20} />
          <Skeleton variant="text" width="40%" height={16} />
        </Box>
        <Skeleton variant="rectangular" width={80} height={32} sx={{ borderRadius: 1 }} />
      </Box>
    ))}
  </Box>
); 